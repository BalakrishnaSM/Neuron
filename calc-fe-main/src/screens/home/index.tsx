import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import {
  ColorSwatch,
  Group,
  ActionIcon,
  Drawer,
  ScrollArea,
  Box,
  Textarea,
  Slider,
  Button as MantineButton,
  Badge,
  Card,
  Stack,
  Text,
  Divider,
  Tooltip,
  useMantineColorScheme,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  Menu,
  Mic,
  Image as LucideImage,
  Send,
  Eraser,
  Pen,
  Square,
  Circle,
  Minus,
  Sun,
  Moon,
  RotateCcw,
  RotateCw,
  Trash2,
  Save,
} from 'lucide-react';
import axios from 'axios';
import Draggable from 'react-draggable';

// ---- CONFIG ----
const API_URL = (import.meta as unknown as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL || 'http://localhost:8900';
// If you keep a constants file, import it; else fallback palette:
const DEFAULT_SWATCHES = [
  '#ffffff',
  '#ef4444',
  '#f59e0b',
  '#10b981',
  '#06b6d4',
  '#3b82f6',
  '#8b5cf6',
  '#f472b6',
  '#94a3b8',
  '#000000',
];

// ---- Types ----
interface GeneratedResult {
  expression: string;
  answer: string;
  steps?: string[];
}

interface CalculationResponse {
  expr: string;
  result: string;
  assign: boolean;
  steps?: string[];
}

interface LatexPosition {
  x: number;
  y: number;
}

interface HistoryItem {
  id: string;
  type: 'solution' | 'audio' | 'image';
  // For solution:
  expression?: string;
  answer?: string;
  steps?: string[];
  // For audio:
  audioUrl?: string;
  // For image:
  imageName?: string;
  // Thumbnail of canvas or uploaded image
  thumbnail?: string;
  createdAt: number;
}

interface Session {
  id: string;
  name: string;
  history: HistoryItem[];
  canvasDataUrl: string;
}

// Add global MathJax typing
declare global {
  interface Window {
    MathJax: {
      Hub: {
        Queue: (args: unknown[]) => void;
        Config: (config: { tex2jax: { inlineMath: string[][] } }) => void;
      };
    };
  }
}

// ---- Utility: local linear/quadratic solver (fallback) ----
function trySolveLocally(input: string): GeneratedResult | null {
  try {
    const s = input.replace(/\s+/g, '').replace(/\*+/g, '');
    // Quadratic ax^2+bx+c=0
    const quad = s.match(
      /^([+-]?\d*\.?\d*)x\^2([+-]?\d*\.?\d*)x([+-]?\d*\.?\d*)=0$/i
    );
    if (quad) {
      const a = parseFloat(quad[1] || '1');
      const b = parseFloat(quad[2] || '0');
      const c = parseFloat(quad[3] || '0');
      if (!isFinite(a) || a === 0) return null;
      const D = b * b - 4 * a * c;
      const steps = [
        `Given: ${a}x^2 + ${b}x + ${c} = 0`,
        `Δ = b^2 - 4ac = ${b}^2 - 4(${a})(${c}) = ${D}`,
      ];
      if (D < 0) {
        const real = -b / (2 * a);
        const imag = Math.sqrt(-D) / (2 * a);
        steps.push(`Complex roots: x = ${real.toFixed(4)} ± ${imag.toFixed(4)}i`);
        return { expression: `${a}x^2+${b}x+${c}=0`, answer: `x = ${real.toFixed(4)} ± ${imag.toFixed(4)}i`, steps };
      }
      const x1 = (-b + Math.sqrt(D)) / (2 * a);
      const x2 = (-b - Math.sqrt(D)) / (2 * a);
      steps.push(`x = (-b ± √Δ) / (2a)`);
      steps.push(`x₁ = ${x1}`);
      steps.push(`x₂ = ${x2}`);
      return { expression: `${a}x^2+${b}x+${c}=0`, answer: `x₁=${x1}, x₂=${x2}`, steps };
    }
    // Linear ax+b=c
    const lin = s.match(/^([+-]?\d*\.?\d*)x([+-]?\d*\.?\d*)=([+-]?\d*\.?\d*)$/i);
    if (lin) {
      const a = parseFloat(lin[1] || '1');
      const b = parseFloat(lin[2] || '0');
      const c = parseFloat(lin[3] || '0');
      if (!isFinite(a) || a === 0) return null;
      const steps = [
        `Given: ${a}x ${b >= 0 ? '+' : ''}${b} = ${c}`,
        `${a}x = ${c} ${b >= 0 ? '-' : '+'} ${Math.abs(b)} = ${c - b}`,
        `x = ${(c - b)}/${a}`,
      ];
      const x = (c - b) / a;
      steps.push(`x = ${x}`);
      return { expression: `${a}x${b >= 0 ? '+' : ''}${b}=${c}`, answer: `x=${x}`, steps };
    }
    return null;
  } catch {
    return null;
  }
}

// ---- Main Component ----
function App() {
  // THEME
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const dark = colorScheme === 'dark';

  // CANVAS refs and state
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [color, setColor] = useState('#ffffff');
  const [thickness, setThickness] = useState<number>(3);
  const [mode, setMode] = useState<'pen' | 'eraser' | 'line' | 'rectangle' | 'circle'>('pen');
  const dpr = window.devicePixelRatio || 1;

  // Reset cursor when tool changes
  const handleModeChange = (newMode: typeof mode) => {
    setMode(newMode);
    setCursorPos(null);
  };

  // Drawing lifecycle refs
  const isDrawingRef = useRef(false);
  const lastPosRef = useRef<{ x: number; y: number } | null>(null);

  // Pan/zoom state (simple 2D view transform)
  const transformRef = useRef({ scale: 1, offsetX: 0, offsetY: 0 });
  const isPanningRef = useRef(false);

  // Shape drawing helpers
  const shapeStartRef = useRef<{ x: number; y: number } | null>(null);
  const snapshotRef = useRef<ImageData | null>(null);

  // LaTeX overlays (draggable)
  const [latexExpression, setLatexExpression] = useState<string[]>([]);
  const [latexPositions, setLatexPositions] = useState<LatexPosition[]>([]);

  // Sessions & History (chat-like)
  const [sessions, setSessions] = useState<Session[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [sidebarOpened, { open: openSidebar, close: closeSidebar }] = useDisclosure(false);

  // Query box (bottom bar)
  const [query, setQuery] = useState('');

  // Loading state for solve button
  const [loading, setLoading] = useState(false);

  // Microphone
  const mediaRef = useRef<MediaRecorder | null>(null);
  const chunksRef: React.MutableRefObject<Blob[]> = useRef([]);

  // Image upload
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Dict of variables received from backend
  const [dictOfVars, setDictOfVars] = useState<Record<string, string>>({});

  // Cursor position for custom cursor indicator
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);

  // Undo/redo: hold canvas snapshots (data URLs)
  const undoStack = useRef<string[]>([]);
  const redoStack = useRef<string[]>([]);



  // ----- Helpers -----
  const pushUndo = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      undoStack.current.push(canvas.toDataURL());
      redoStack.current = [];
    } catch (error) {
      console.error('Failed to push undo state:', error);
    }
  }, []);

  const restoreFromDataURL = (url: string) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = new Image();
    img.onload = () => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      // restore board bg
      ctx.fillStyle = dark ? '#000' : '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
    };
    img.src = url;
  };

  const undo = () => {
    const canvas = canvasRef.current;
    if (!canvas || undoStack.current.length === 0) return;
    const current = canvas.toDataURL();
    const prev = undoStack.current.pop()!;
    redoStack.current.push(current);
    restoreFromDataURL(prev);
  };

  const redo = () => {
    const canvas = canvasRef.current;
    if (!canvas || redoStack.current.length === 0) return;
    const current = canvas.toDataURL();
    const next = redoStack.current.pop()!;
    undoStack.current.push(current);
    restoreFromDataURL(next);
  };

  const clearBoard = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    pushUndo();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = dark ? '#000' : '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  };

  // ---- Canvas init & event handling ----
  useEffect(() => {
    const canvas = canvasRef.current!;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;

    const setSize = () => {
      // Responsive sizing for all devices
      let w = window.innerWidth;
      let h = window.innerHeight;
      // For desktop, use min size; for mobile, use full viewport
      if (w > 800) {
        w = Math.max(w, 1600);
        h = Math.max(h, 1200);
      }
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = dark ? '#000' : '#fff';
      ctx.fillRect(0, 0, w, h);
    };

    setSize();
    const onResize = () => setSize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [dark]);

  // PAN/ZOOM
  useEffect(() => {
    const canvas = canvasRef.current!;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const t = transformRef.current;

    const applyTransform = () => {
      ctx.setTransform(t.scale, 0, 0, t.scale, t.offsetX, t.offsetY);
    };

    // Wheel zoom
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return; // pinch-zoom or ctrl+wheel
      e.preventDefault();
      const { offsetX, offsetY, deltaY } = e;
      const direction = deltaY > 0 ? -1 : 1;
      const factor = 1 + direction * 0.1;
      // Zoom towards cursor
      const wx = (offsetX - t.offsetX) / t.scale;
      const wy = (offsetY - t.offsetY) / t.scale;
      t.scale *= factor;
      t.offsetX = offsetX - wx * t.scale;
      t.offsetY = offsetY - wy * t.scale;
      applyTransform();
    };

    // Pinch-to-zoom and multi-touch pan
  // Removed unused variable lastTouches
    let lastDistance = 0;
    let lastCenter = { x: 0, y: 0 };
    const getTouchCenter = (touches: TouchList) => {
      const x = (touches[0].clientX + touches[1].clientX) / 2;
      const y = (touches[0].clientY + touches[1].clientY) / 2;
      return { x, y };
    };
    const getTouchDistance = (touches: TouchList) => {
      const dx = touches[0].clientX - touches[1].clientX;
      const dy = touches[0].clientY - touches[1].clientY;
      return Math.sqrt(dx * dx + dy * dy);
    };
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        lastDistance = getTouchDistance(e.touches);
        lastCenter = getTouchCenter(e.touches);
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const newDistance = getTouchDistance(e.touches);
        const newCenter = getTouchCenter(e.touches);
        // Pinch zoom
        const scaleChange = newDistance / lastDistance;
        t.scale *= scaleChange;
        // Pan
        t.offsetX += newCenter.x - lastCenter.x;
        t.offsetY += newCenter.y - lastCenter.y;
        lastDistance = newDistance;
        lastCenter = newCenter;
        applyTransform();
      }
    };
    canvas.addEventListener('touchstart', onTouchStart, { passive: false });
    canvas.addEventListener('touchmove', onTouchMove, { passive: false });

    // Space + drag to pan
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        isPanningRef.current = true;
        canvas.style.cursor = 'grabbing';
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        isPanningRef.current = false;
        canvas.style.cursor = 'default';
      }
    };
    let lastPan = { x: 0, y: 0 };
    const onMouseDown = (e: MouseEvent) => {
      if (isPanningRef.current) {
        lastPan = { x: e.clientX, y: e.clientY };
        window.addEventListener('mousemove', onMouseMovePan);
        window.addEventListener('mouseup', onMouseUpPan);
      }
    };
    const onMouseMovePan = (e: MouseEvent) => {
      const dx = e.clientX - lastPan.x;
      const dy = e.clientY - lastPan.y;
      lastPan = { x: e.clientX, y: e.clientY };
      t.offsetX += dx;
      t.offsetY += dy;
      applyTransform();
    };
    const onMouseUpPan = () => {
      window.removeEventListener('mousemove', onMouseMovePan);
      window.removeEventListener('mouseup', onMouseUpPan);
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    canvas.addEventListener('mousedown', onMouseDown);

    return () => {
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchmove', onTouchMove);
    };
  }, []);

  // DRAWING & SHAPES
  useEffect(() => {
    const canvas = canvasRef.current!;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;

    const t = transformRef.current;
    const toWorld = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      // Use CSS pixel coordinates
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      // Convert to device pixels
      const ctx_x = x * dpr;
      const ctx_y = y * dpr;
      // Inverse transform
      const wx = (ctx_x - t.offsetX) / t.scale;
      const wy = (ctx_y - t.offsetY) / t.scale;
      return { x: wx, y: wy };
    };

    // Auto-grow canvas near edges
    const ensureCapacity = (x: number, y: number) => {
      const margin = 50;
      let grew = false;
      // Use CSS pixel values for width/height
      const widthCSS = parseFloat(canvas.style.width || '0');
      const heightCSS = parseFloat(canvas.style.height || '0');
      if (x > widthCSS - margin) {
        grew = true;
        const newW = widthCSS + 600;
        const temp = document.createElement('canvas');
        temp.width = Math.floor(newW * dpr);
        temp.height = Math.floor(heightCSS * dpr);
        const tctx = temp.getContext('2d')!;
        tctx.scale(dpr, dpr);
        // fill bg
        tctx.fillStyle = dark ? '#000' : '#fff';
        tctx.fillRect(0, 0, newW, heightCSS);
        // draw old
        tctx.drawImage(canvas, 0, 0);
        canvas.width = temp.width;
        canvas.style.width = `${newW}px`;
        const c2 = canvas.getContext('2d')!;
        c2.resetTransform();
        c2.scale(dpr, dpr);
        c2.drawImage(temp, 0, 0);
      }
      if (y > heightCSS - margin) {
        grew = true;
        const newH = heightCSS + 600;
        const temp = document.createElement('canvas');
        temp.width = Math.floor(widthCSS * dpr);
        temp.height = Math.floor(newH * dpr);
        const tctx = temp.getContext('2d')!;
        tctx.scale(dpr, dpr);
        tctx.fillStyle = dark ? '#000' : '#fff';
        tctx.fillRect(0, 0, widthCSS, newH);
        tctx.drawImage(canvas, 0, 0);
        canvas.height = temp.height;
        canvas.style.height = `${newH}px`;
        const c2 = canvas.getContext('2d')!;
        c2.resetTransform();
        c2.scale(dpr, dpr);
        c2.drawImage(temp, 0, 0);
      }
      if (grew) {
        // reapply transform after dimension change
        const tr = transformRef.current;
        ctx.setTransform(tr.scale, 0, 0, tr.scale, tr.offsetX, tr.offsetY);
      }
    };

    // For shapes: snapshot before drawing preview
    const snapshotCanvas = () => {
      const widthCSS = parseFloat(canvas.style.width || '0');
      const heightCSS = parseFloat(canvas.style.height || '0');
      const tr = ctx.getTransform();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const snap = ctx.getImageData(0, 0, widthCSS, heightCSS);
      ctx.setTransform(tr);
      return snap;
    };
    const restoreSnapshot = (snap: ImageData) => {
      const tr = ctx.getTransform();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.putImageData(snap, 0, 0);
      ctx.setTransform(tr);
    };

    // For smoothing
    const points: { x: number; y: number }[] = [];
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== 'pen' && e.pointerType !== 'mouse') return;
      const p = toWorld(e.clientX, e.clientY);
      ensureCapacity(p.x, p.y);
      setCursorPos(p);
      pushUndo();
      if (mode === 'pen' || mode === 'eraser') {
        isDrawingRef.current = true;
        lastPosRef.current = p;
        points.length = 0;
        points.push(p);
        ctx.globalCompositeOperation = mode === 'eraser' ? 'destination-out' : 'source-over';
        ctx.strokeStyle = color;
        const pressure = e.pressure === 0 ? 1 : e.pressure;
        ctx.lineWidth = (mode === 'eraser' ? thickness * 4 : thickness) * (0.5 + pressure / 2);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
      } else {
        shapeStartRef.current = p;
        snapshotRef.current = snapshotCanvas();
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType !== 'pen' && e.pointerType !== 'mouse') return;
      const p = toWorld(e.clientX, e.clientY);
      ensureCapacity(p.x, p.y);
      setCursorPos(p);

      if (mode === 'pen' || mode === 'eraser') {
        if (!isDrawingRef.current) return;
        points.push(p);
        const pressure = e.pressure === 0 ? 1 : e.pressure;
        ctx.lineWidth = (mode === 'eraser' ? thickness * 4 : thickness) * (0.5 + pressure / 2);
        // Smoothing: draw quadratic curve between last 3 points
        if (points.length >= 3) {
          const p0 = points[points.length - 3];
          const p1 = points[points.length - 2];
          const p2 = points[points.length - 1];
          ctx.beginPath();
          ctx.moveTo(p0.x, p0.y);
          ctx.quadraticCurveTo(p1.x, p1.y, p2.x, p2.y);
          ctx.stroke();
        } else {
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
        }
        lastPosRef.current = p;
      } else if (shapeStartRef.current && snapshotRef.current) {
        restoreSnapshot(snapshotRef.current);
        ctx.strokeStyle = color;
        ctx.lineWidth = thickness;
        const a = shapeStartRef.current;
        if (mode === 'line') {
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
        }
        if (mode === 'rectangle') {
          const w = p.x - a.x;
          const h = p.y - a.y;
          ctx.strokeRect(a.x, a.y, w, h);
        }
        if (mode === 'circle') {
          const r = Math.hypot(p.x - a.x, p.y - a.y);
          ctx.beginPath();
          ctx.arc(a.x, a.y, r, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    };

    const onPointerUp = () => {
      isDrawingRef.current = false;
      lastPosRef.current = null;
      shapeStartRef.current = null;
      snapshotRef.current = null;
      ctx.globalCompositeOperation = 'source-over';
      setCursorPos(null); // Hide cursor indicator when not drawing
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointerleave', onPointerUp);

    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerUp);
      setCursorPos(null); // Clean up cursor position when unmounting
    };
  }, [color, thickness, mode, dark, pushUndo, setCursorPos]);

  // MATHJAX loader
  useEffect(() => {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/mathjax/2.7.9/MathJax.js?config=TeX-MML-AM_CHTML';
    script.async = true;
    document.head.appendChild(script);
    script.onload = () => {
      if (window.MathJax) {
        (window.MathJax.Hub.Config as any)({
          tex2jax: {
            inlineMath: [['$', '$'], ['\\(', '\\)']],
            displayMath: [['$$', '$$'], ['\\[', '\\]']]
          },
          CommonHTML: {
            linebreaks: {
              automatic: true,
              width: 'container'
            }
          },
          TeX: {
            linebreaks: {
              automatic: true,
              width: 'container'
            }
          }
        });
      }
    };
    return () => {
      document.head.removeChild(script);
    };
  }, []);

  useEffect(() => {
    if (latexExpression.length > 0 && window.MathJax) {
      window.MathJax.Hub.Queue(['Typeset', window.MathJax.Hub]);
    }
  }, [latexExpression]);

  // SESSIONS load/save
  useEffect(() => {
    const stored = localStorage.getItem('neuron_sessions_v1');
    if (stored) setSessions(JSON.parse(stored));
    const storedH = localStorage.getItem('neuron_history_v1');
    if (storedH) setHistory(JSON.parse(storedH));
  }, []);

  const saveSession = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const id = Date.now().toString();
    const newSession: Session = {
      id,
      name: `Session ${sessions.length + 1}`,
      history,
      canvasDataUrl: canvas.toDataURL(),
    };
    const updated = [...sessions, newSession];
    setSessions(updated);
    try {
      localStorage.setItem('neuron_sessions_v1', JSON.stringify(updated));
    } catch (error) {
      console.warn('Failed to save sessions to localStorage:', error);
    }
  }, [sessions, history]);

  const loadSession = useCallback((s: Session) => {
    restoreFromDataURL(s.canvasDataUrl);
    setHistory(s.history);
    closeSidebar();
  }, [closeSidebar]);

  const resetAll = useCallback(() => {
    clearBoard();
    setLatexExpression([]);
    setLatexPositions([]);
    setHistory([]);
    setDictOfVars({});
    localStorage.removeItem('neuron_history_v1');
  }, []);

  // IMAGE upload
  const onPickImage = () => fileInputRef.current?.click();
  const onImageFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = canvasRef.current!;
        const ctx = canvas.getContext('2d')!;
        pushUndo();
        const maxW = 600;
        const scale = Math.min(1, maxW / img.width);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, 80, 80, w, h);
        // history
        const item: HistoryItem = {
          id: Date.now() + '_img',
          type: 'image',
          imageName: f.name,
          thumbnail: canvas.toDataURL(),
          createdAt: Date.now(),
        };
        const newH = [item, ...history];
        setHistory(newH);
        try {
          localStorage.setItem('neuron_history_v1', JSON.stringify(newH));
        } catch (error) {
          console.warn('Failed to save history to localStorage:', error);
        }
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(f);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // MICROPHONE
  const [recording, setRecording] = useState(false);
  const toggleMic = async () => {
    if (recording) {
      mediaRef.current?.stop();
      setRecording(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      mediaRef.current = rec;
      chunksRef.current = [];
      rec.ondataavailable = (e) => chunksRef.current.push(e.data);
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        const url = URL.createObjectURL(blob);
        const item: HistoryItem = {
          id: Date.now() + '_aud',
          type: 'audio',
          audioUrl: url,
          createdAt: Date.now(),
        };
        const newH = [item, ...history];
        setHistory(newH);
        try {
          localStorage.setItem('neuron_history_v1', JSON.stringify(newH));
        } catch (error) {
          console.warn('Failed to save history to localStorage:', error);
        }
      };
      rec.start();
      setRecording(true);
    } catch (error) {
      console.error('Microphone permission denied:', error);
      alert('Microphone permission denied.');
    }
  };

  // RUN calculation: send text or canvas → backend; else try local
  const runCalculation = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    setLoading(true);
    setQuery(''); // Clear the text area

    // Prefer backend
    try {
      const payload: any = {
        dict_of_vars: dictOfVars,
      };
      if (query.trim()) {
        payload.text = query.trim();
      } else {
        // Crop the canvas to the drawn area for better OCR performance
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        let minX = canvas.width, minY = canvas.height, maxX = 0, maxY = 0;
        let hasDrawing = false;

        for (let y = 0; y < canvas.height; y++) {
          for (let x = 0; x < canvas.width; x++) {
            const i = (y * canvas.width + x) * 4;
            if (imageData.data[i + 3] > 0) { // alpha > 0
              minX = Math.min(minX, x);
              minY = Math.min(minY, y);
              maxX = Math.max(maxX, x);
              maxY = Math.max(maxY, y);
              hasDrawing = true;
            }
          }
        }

        if (hasDrawing) {
          const croppedWidth = maxX - minX + 1;
          const croppedHeight = maxY - minY + 1;
          const croppedCanvas = document.createElement('canvas');
          croppedCanvas.width = croppedWidth;
          croppedCanvas.height = croppedHeight;
          const croppedCtx = croppedCanvas.getContext('2d');
          if (croppedCtx) {
            croppedCtx.drawImage(
              canvas,
              minX, minY, croppedWidth, croppedHeight,
              0, 0, croppedWidth, croppedHeight
            );
            payload.image = croppedCanvas.toDataURL('image/png');
          } else {
            payload.image = canvas.toDataURL('image/png');
          }
        } else {
          payload.image = canvas.toDataURL('image/png');
        }
      }
      const response = await axios.post<{data: CalculationResponse[]}>(
        `${API_URL}/calculate`,
        payload,
        { timeout: 180000 }
      );

      const resp = response.data;
      const newVars: Record<string, string> = {};
      const solutions: GeneratedResult[] = [];

      resp.data.forEach((r) => {
        if (r.assign) newVars[r.expr] = r.result;
        solutions.push({
          expression: r.expr,
          answer: r.result,
          steps: r.steps && r.steps.length ? r.steps : trySolveLocally(r.expr)?.steps,
        });
      });

      setDictOfVars((prev) => ({ ...prev, ...newVars }));

      // Render LaTeX + History
      const newLatex: string[] = [];
      const newPositions: LatexPosition[] = [];
      const newHistory: HistoryItem[] = [];

      solutions.forEach((sol, idx) => {
        const latex = `\\[\\LARGE ${escapeHtml(sol.expression)} = ${escapeHtml(sol.answer)} \\]`;
        newLatex.push(latex);
        newPositions.push({ x: 120, y: 200 + idx * 48 });

        const item: HistoryItem = {
          id: Date.now() + '_sol_' + idx,
          type: 'solution',
          expression: sol.expression,
          answer: sol.answer,
          steps: sol.steps && sol.steps.length ? sol.steps : ['(No steps provided)'],
          thumbnail: canvas.toDataURL(),
          createdAt: Date.now(),
        };
        newHistory.push(item);
      });

      setLatexExpression((prev) => [...prev, ...newLatex]);
      setLatexPositions((prev) => [...prev, ...newPositions]);
      const mergedHistory = [...newHistory, ...history];
      setHistory(mergedHistory);
      try {
        localStorage.setItem('neuron_history_v1', JSON.stringify(mergedHistory));
      } catch (error) {
        console.warn('Failed to save history to localStorage:', error);
      }
      return;
    } catch (error) {
      console.error('Backend calculation failed:', error);
      // no-op; fallback below
    } finally {
      setLoading(false);
    }

    // Fallback: use typed query if present
    if (query.trim()) {
      const local = trySolveLocally(query.trim());
      if (local) {
        const canvasUrl = canvas.toDataURL();
        const html = `<div style="white-space: pre-wrap; word-break: break-word; max-width: 80vw; font-size: 14px;">${escapeHtml(local.expression)} = ${escapeHtml(local.answer)}</div>`;
        setLatexExpression((prev) => [...prev, html]);
        setLatexPositions((prev) => [...prev, { x: 120, y: 200 + prev.length * 48 }]);
    const item: HistoryItem = {
      id: Date.now() + '_sol_local',
      type: 'solution',
      expression: local.expression,
      answer: local.answer,
      steps: local.steps,
      thumbnail: canvasUrl,
      createdAt: Date.now(),
    };
    const newH = [item, ...history];
    setHistory(newH);
    try {
      localStorage.setItem('neuron_history_v1', JSON.stringify(newH));
    } catch (error) {
      console.warn('Failed to save history to localStorage:', error);
    }
        return;
      }
    }

    alert('No backend response and local solver could not parse the equation. Enter a linear or quadratic (e.g., 2x+3=9 or 1x^2+2x+1=0).');
    setLoading(false);
  }, [dictOfVars, history, query]);

  // SAFETY: sanitize HTML for LaTeX wrapper
  function escapeHtml(s: string) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  // THEME toggle
  const toggleTheme = () => setColorScheme(dark ? 'light' : 'dark');

  
  // Custom cursor size based on current tool and thickness
  const getCursorSize = useCallback(() => {
    if (mode === 'eraser') return thickness * 8;
    if (mode === 'pen') return thickness * 2;
    return 16; // Default size for shape tools
  }, [mode, thickness]);

  // Memo cursor position to avoid unnecessary re-renders
  const cursorStyle = useMemo(() => {
    if (!cursorPos) return null;
    const { scale, offsetX, offsetY } = transformRef.current;
    const size = getCursorSize();
    return {
      position: 'absolute',
      left: ((cursorPos.x * scale + offsetX) / dpr) - size / 2,
      top: ((cursorPos.y * scale + offsetY) / dpr) - size / 2,
      width: size,
      height: size,
      borderRadius: '50%',
      border: '2px solid #6366f1',
      background: mode === 'eraser' ? 'rgba(239,68,68,0.12)' : 'rgba(99,102,241,0.12)',
      pointerEvents: 'none',
      zIndex: 10,
      boxShadow: mode === 'eraser' ? '0 0 4px #ef4444' : '0 0 4px #6366f1',
      opacity: 0.9,
      transition: 'width 0.2s, height 0.2s',
      transform: `scale(${1 / (scale * dpr)})`, // Maintain cursor size when zooming
    } as const;
  }, [cursorPos, mode, getCursorSize, dpr]);

  // UI
  return (
      <Box
        className="w-full h-full"
        style={{
          background: dark ? '#000' : '#fff',
          color: dark ? '#fff' : '#111',
          transition: 'background 200ms ease, color 200ms ease',
          minHeight: '100vh',
          minWidth: '100vw',
          boxSizing: 'border-box',
          overflow: 'hidden',
        }}
      >
        {/* HEADER / BRAND */}
        <Box
          style={{
            position: 'fixed',
            inset: '16px auto auto 16px',
            zIndex: 60,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <ActionIcon variant="subtle" onClick={openSidebar} aria-label="Open sessions">
            <Menu />
          </ActionIcon>
          <Text fw={700} fz={28} style={{ letterSpacing: 0.5 }}>
            🧠 Neuron
          </Text>
          <Badge color="grape" variant="light">
            Math Notes
          </Badge>
        </Box>

        {/* FLOATING TOOLS (top-right) */}
        <Box
          style={{
            position: 'fixed',
            top: 16,
            right: 16,
            display: 'flex',
            gap: 10,
            zIndex: 60,
            alignItems: 'center',
          }}
        >
          {/* Palette */}
          <Group gap="xs">
            {(DEFAULT_SWATCHES).map((sw) => (
              <ColorSwatch
                key={sw}
                color={sw}
                onClick={() => setColor(sw)}
                style={{ cursor: 'pointer', border: sw === '#ffffff' && dark ? '1px solid #444' : 'none' }}
                radius="xl"
              />
            ))}
          </Group>

          {/* Tools */}
          <Tooltip label="Pen">
            <ActionIcon
              variant={mode === 'pen' ? 'filled' : 'light'}
              onClick={() => handleModeChange('pen')}
              aria-label="Pen"
              style={mode === 'pen' ? { border: '2px solid #6366f1', background: 'rgba(99,102,241,0.12)' } : {}}
            >
              <Pen size={18} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Eraser">
            <ActionIcon
              variant={mode === 'eraser' ? 'filled' : 'light'}
              onClick={() => handleModeChange('eraser')}
              aria-label="Eraser"
              style={mode === 'eraser' ? { border: '2px solid #f59e0b', background: 'rgba(245,158,11,0.12)' } : {}}
            >
              <Eraser size={18} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Line">
            <ActionIcon
              variant={mode === 'line' ? 'filled' : 'light'}
              onClick={() => handleModeChange('line')}
              aria-label="Line"
              style={mode === 'line' ? { border: '2px solid #10b981', background: 'rgba(16,185,129,0.12)' } : {}}
            >
              <Minus size={18} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Rectangle">
            <ActionIcon
              variant={mode === 'rectangle' ? 'filled' : 'light'}
              onClick={() => handleModeChange('rectangle')}
              aria-label="Rectangle"
              style={mode === 'rectangle' ? { border: '2px solid #ef4444', background: 'rgba(239,68,68,0.12)' } : {}}
            >
              <Square size={18} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Circle">
            <ActionIcon
              variant={mode === 'circle' ? 'filled' : 'light'}
              onClick={() => handleModeChange('circle')}
              aria-label="Circle"
              style={mode === 'circle' ? { border: '2px solid #06b6d4', background: 'rgba(6,182,212,0.12)' } : {}}
            >
              <Circle size={18} />
            </ActionIcon>
          </Tooltip>

          {/* Thickness */}
          <Box style={{ width: 120, paddingInline: 6 }}>
            <Slider
              min={1}
              max={24}
              step={1}
              value={thickness}
              onChange={setThickness}
              label={(v) => `${v}px`}
            />
          </Box>

          {/* Undo/Redo/Clear/Save */}
          <Tooltip label="Undo">
            <ActionIcon onClick={undo} aria-label="Undo">
              <RotateCcw />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Redo">
            <ActionIcon onClick={redo} aria-label="Redo">
              <RotateCw />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Clear">
            <ActionIcon onClick={clearBoard} aria-label="Clear">
              <Trash2 />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Save session">
            <ActionIcon onClick={saveSession} aria-label="Save session">
              <Save />
            </ActionIcon>
          </Tooltip>

          {/* Theme */}
          <Tooltip label="Toggle theme">
            <ActionIcon onClick={toggleTheme} aria-label="Toggle theme">
              {dark ? <Sun /> : <Moon />}
            </ActionIcon>
          </Tooltip>
        </Box>

        {/* CANVAS */}
        <canvas
          ref={canvasRef}
          id="canvas"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            touchAction: 'none',
            cursor: 'none', // Hide default cursor
            zIndex: 1,
          }}
        />
        {/* Custom cursor indicator */}
        {cursorStyle && <div style={cursorStyle} />}

        {/* LaTeX overlays (draggable) */}
        {latexExpression.map((latex, i) => (
          <Draggable
            key={i}
            defaultPosition={latexPositions[i] || { x: 120, y: 200 + i * 48 }}
            bounds="parent"
            onStop={(_e, data) => {
              const next = [...latexPositions];
              next[i] = { x: data.x, y: data.y };
              setLatexPositions(next);
            }}
          >
            <div
              className="latex"
              style={{
                position: 'absolute',
                zIndex: 40,
                padding: 6,
                color: dark ? '#fff' : '#111',
                mixBlendMode: dark ? 'screen' : 'multiply',
                background: 'transparent',
                userSelect: 'none',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                overflowWrap: 'break-word',
                maxWidth: '80vw',
                fontSize: '14px',
              }}
              dangerouslySetInnerHTML={{ __html: latex }}
            />
          </Draggable>
        ))}

        {/* BOTTOM BAR (glass) */}
        <Box
          p="sm"
          style={{
            position: 'fixed',
            left: 16,
            right: 16,
            bottom: 16,
            zIndex: 55,
            borderRadius: 12,
            backdropFilter: 'blur(10px)',
            background: dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
            border: dark ? '1px solid rgba(255,255,255,0.1)' : '1px solid rgba(0,0,0,0.08)',
          }}
        >
          <Group gap="sm" align="center">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={onImageFile}
              style={{ display: 'none' }}
            />
            <Tooltip label={recording ? 'Stop recording' : 'Record'}>
              <ActionIcon size="lg" variant="light" onClick={toggleMic} aria-label="Microphone">
                <Mic style={{ color: recording ? '#ef4444' : undefined }} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Upload image">
              <ActionIcon size="lg" variant="light" onClick={onPickImage} aria-label="Upload image">
                <LucideImage />
              </ActionIcon>
            </Tooltip>
            <Textarea
              placeholder="Type an equation (e.g., 2x+3=9) — or just write on the canvas"
              autosize
              minRows={1}
              maxRows={4}
              style={{ flex: 1 }}
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
            />
            <MantineButton onClick={runCalculation} variant="light" leftSection={<Send size={16} />} loading={loading}>
              Solve
            </MantineButton>
          </Group>
          {/* Virtual Math Keyboard */}
          <Group gap="xs" mt={8} style={{ flexWrap: 'wrap', justifyContent: 'center' }}>
            {['+', '-', '×', '÷', '=', '(', ')', '^', '√', 'π', 'e', 'x', 'y', 'z', '<', '>', '≤', '≥', '≠', 'frac', '∫', '∑', 'sin', 'cos', 'tan', 'log', 'ln'].map((key) => (
              <MantineButton
                key={key}
                size="xs"
                variant="subtle"
                style={{ minWidth: 32, minHeight: 32, fontSize: 16 }}
                onClick={() => {
                  if (key === 'frac') {
                    setQuery((q) => q + '\\frac{a}{b}');
                  } else {
                    setQuery((q) => q + key);
                  }
                }}
              >
                {key}
              </MantineButton>
            ))}
          </Group>
        </Box>

        {/* SIDEBAR: Sessions + History */}
        <Drawer
          opened={sidebarOpened}
          onClose={closeSidebar}
          title="Neuron — Sessions & History"
          size="md"
          overlayProps={{ opacity: 0.2, blur: 2 }}
        >
          <ScrollArea h="100%">
            <Stack gap="md">
              <MantineButton fullWidth onClick={saveSession} leftSection={<Save size={16} />}>
                Save Current Session
              </MantineButton>
              <MantineButton fullWidth color="red" onClick={resetAll} leftSection={<Trash2 size={16} />}>
                Reset Board & History
              </MantineButton>

              <Divider label="History (latest first)" />
              {history.length === 0 && <Text c="dimmed">No history yet.</Text>}
              {history.map((h, _idx) => (
                <Box
                  key={h.id}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: h.type === 'solution' ? 'flex-end' : 'flex-start',
                    marginBottom: 16,
                  }}
                >
                  <Box
                    style={{
                      maxWidth: '80%',
                      background: h.type === 'solution' ? 'linear-gradient(90deg,#6366f1 60%,#818cf8 100%)' : h.type === 'audio' ? 'linear-gradient(90deg,#06b6d4 60%,#38bdf8 100%)' : 'linear-gradient(90deg,#f59e0b 60%,#fbbf24 100%)',
                      color: '#fff',
                      borderRadius: 18,
                      padding: '16px 20px',
                      boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
                      position: 'relative',
                    }}
                  >
                    <Group justify="space-between" align="flex-start" style={{ marginBottom: 8 }}>
                      <Badge variant="dot" color={h.type === 'solution' ? 'green' : h.type === 'audio' ? 'blue' : 'violet'}>
                        {h.type.toUpperCase()}
                      </Badge>
                      <Text size="sm" c="dimmed">
                        {new Date(h.createdAt).toLocaleString()}
                      </Text>
                    </Group>
                    {h.thumbnail && (
                      <img
                        src={h.thumbnail}
                        alt="thumb"
                        height={48}
                        style={{ borderRadius: 6, opacity: 0.9, marginBottom: 8 }}
                      />
                    )}
                    {h.type === 'solution' && (
                      <>
                        <Text fw={700} style={{ marginBottom: 4 }}>{h.expression}</Text>
                        <Text style={{ marginBottom: 8 }}>Answer: {h.answer}</Text>
                        <Divider my="xs" />
                        <Text fw={600} mb={4}>Steps:</Text>
                        <Stack gap={4}>
                          {(h.steps || []).map((s, i) => (
                            <Text key={i} size="sm">• {s}</Text>
                          ))}
                        </Stack>
                      </>
                    )}
                    {h.type === 'audio' && h.audioUrl && (
                      <Box mt="sm">
                        <audio controls src={h.audioUrl} style={{ width: '100%' }} />
                      </Box>
                    )}
                    {h.type === 'image' && h.imageName && (
                      <Box mt="sm">
                        <Text size="sm">Uploaded: {h.imageName}</Text>
                      </Box>
                    )}
                  </Box>
                </Box>
              ))}

              <Divider label="Saved Sessions" />
              {sessions.length === 0 && <Text c="dimmed">No saved sessions.</Text>}
              {sessions.map((s) => (
                <Card key={s.id} withBorder radius="md" shadow="sm">
                  <Group justify="space-between">
                    <Text fw={600}>{s.name}</Text>
                    <MantineButton size="xs" variant="subtle" onClick={() => loadSession(s)}>
                      Load
                    </MantineButton>
                  </Group>
                  <Box mt="sm">
                    <img
                      src={s.canvasDataUrl}
                      alt={s.name}
                      style={{ width: '100%', borderRadius: 8, opacity: 0.9 }}
                    />
                  </Box>
                </Card>
              ))}
            </Stack>
          </ScrollArea>
        </Drawer>
      </Box>
  );
}

export default App;  