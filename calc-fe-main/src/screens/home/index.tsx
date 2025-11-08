import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { useAuth } from '@/contexts/AuthContext';

import { LogOut } from 'lucide-react';
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
  Menu,
  Select,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
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
  User,
} from 'lucide-react';
import axios from 'axios';
import Draggable from 'react-draggable';

// ---- CONFIG ----
const API_URL = (import.meta as unknown as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL || 'http://localhost:8900';
// Fallback color palette:
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
const TARGET_VLM_SIZE = 512; // Standard size for most VLMs like moondream

// Audio blob ref removed as Dwani is no longer used

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
  audioUrl?: string; // Stored locally for playback
  audioSent?: boolean; // New: Flag to indicate audio was sent to backend
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

// Add global MathJax and SpeechRecognition typing
declare global {
  interface Window {
    MathJax: {
      Hub: {
        Queue: (args: unknown[]) => void;
        Config: (config: { tex2jax: { inlineMath: string[][] } }) => void;
      };
    };
    SpeechRecognition: typeof SpeechRecognition;
    webkitSpeechRecognition: typeof SpeechRecognition;
  }

  interface SpeechRecognition extends EventTarget {
    continuous: boolean;
    interimResults: boolean;
    lang: string;
    start(): void;
    stop(): void;
    onresult: ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => any) | null;
    onerror: ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => any) | null;
    onend: ((this: SpeechRecognition, ev: Event) => any) | null;
  }

  interface SpeechRecognitionEvent extends Event {
    results: SpeechRecognitionResultList;
  }

  interface SpeechRecognitionErrorEvent extends Event {
    error: string;
  }

  interface SpeechRecognitionResultList {
    [index: number]: SpeechRecognitionResult;
    length: number;
  }

  interface SpeechRecognitionResult {
    [index: number]: SpeechRecognitionAlternative;
    length: number;
  }

  interface SpeechRecognitionAlternative {
    transcript: string;
    confidence: number;
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

// UTILITY: Convert Blob to Base64 String (removed as unused)


// SAFETY: sanitize HTML for LaTeX wrapper
function escapeHtml(s: string) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

// ---- Main Component ----
function App() {
  const { logout, user } = useAuth();

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

  // Speech Recognition
  const [selectedLanguage, setSelectedLanguage] = useState("en-US");
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);

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
      // Clear and reset transform to draw the background and saved state
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      // restore board bg
      ctx.fillStyle = dark ? '#000' : '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      // Reapply the canvas transform after loading the image
      const t = transformRef.current;
      ctx.setTransform(t.scale, 0, 0, t.scale, t.offsetX, t.offsetY);
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
    // Restore the current pan/zoom state after clearing
    const t = transformRef.current;
    ctx.setTransform(t.scale, 0, 0, t.scale, t.offsetX, t.offsetY);
  };

  // ---- Canvas init & event handling ----
  useEffect(() => {
    const canvas = canvasRef.current!;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;

    const setSize = () => {
      // Use full viewport for responsive sizing
      const w_css = window.innerWidth;
      const h_css = window.innerHeight;
      
      canvas.width = Math.floor(w_css * dpr);
      canvas.height = Math.floor(h_css * dpr);
      canvas.style.width = `${w_css}px`;
      canvas.style.height = `${h_css}px`;
      
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      
      // Apply scaling for HiDPI displays
      ctx.scale(dpr, dpr);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      
      // Fill background (handle existing pan/zoom state if possible)
      const t = transformRef.current;
      ctx.setTransform(t.scale, 0, 0, t.scale, t.offsetX, t.offsetY);
      
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = dark ? '#000' : '#fff';
      ctx.fillRect(0, 0, w_css, h_css);
      ctx.setTransform(t.scale, 0, 0, t.scale, t.offsetX, t.offsetY);
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
      // Zoom towards cursor (in CSS pixels)
      const wx = (offsetX - t.offsetX) / t.scale;
      const wy = (offsetY - t.offsetY) / t.scale;
      t.scale *= factor;
      t.offsetX = offsetX - wx * t.scale;
      t.offsetY = offsetY - wy * t.scale;
      applyTransform();
    };

    // Pinch-to-zoom and multi-touch pan
    let lastDistance = 0;
    let lastCenter = { x: 0, y: 0 };
    const getTouchCenter = (touches: TouchList) => {
      const rect = canvas.getBoundingClientRect();
      const x = (touches[0].clientX + touches[1].clientX) / 2 - rect.left;
      const y = (touches[0].clientY + touches[1].clientY) / 2 - rect.top;
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
        const oldScale = t.scale;
        t.scale *= scaleChange;

        // Zoom toward center
        const wx = (lastCenter.x * dpr - t.offsetX) / oldScale;
        const wy = (lastCenter.y * dpr - t.offsetY) / oldScale;
        t.offsetX = newCenter.x * dpr - wx * t.scale;
        t.offsetY = newCenter.y * dpr - wy * t.scale;
        
        lastDistance = newDistance;
        lastCenter = newCenter;
        applyTransform();
      }
    };
    const onTouchEnd = () => {
        lastDistance = 0;
    }
    
    canvas.addEventListener('touchstart', onTouchStart, { passive: false });
    canvas.addEventListener('touchmove', onTouchMove, { passive: false });
    canvas.addEventListener('touchend', onTouchEnd, { passive: false });

    // Space + drag to pan
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isPanningRef.current) {
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
      // Pan distance in CSS pixels, apply to offset
      const dx = e.clientX - lastPan.x;
      const dy = e.clientY - lastPan.y;
      lastPan = { x: e.clientX, y: e.clientY };
      t.offsetX += dx * dpr;
      t.offsetY += dy * dpr;
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
      canvas.removeEventListener('touchend', onTouchEnd);
    };
  }, [dpr]);

  // DRAWING & SHAPES
  useEffect(() => {
    const canvas = canvasRef.current!;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;

    const t = transformRef.current;
    
    // Convert client coordinates (CSS pixels) to world coordinates (Canvas/Drawing pixels)
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
    
    // Convert world coordinates to CSS pixel coordinates (for custom cursor)
    const toScreen = (worldX: number, worldY: number) => {
      const screenX = (worldX * t.scale + t.offsetX) / dpr;
      const screenY = (worldY * t.scale + t.offsetY) / dpr;
      return { x: screenX, y: screenY };
    }

    // Auto-grow canvas near edges (Simplified logic for the current setup)
    const ensureCapacity = (x: number, y: number) => {
      const margin = 50 * dpr; // Margin in device pixels
      let grew = false;
      
      const currentW = canvas.width;
      const currentH = canvas.height;

      // Note: x and y here are in *device pixels* due to ctx_x/ctx_y logic not being used 
      // in the toWorld function's return. Let's rely on CSS pixel check for simplicity, 
      // but ensure we use dpr correctly in the growth logic.
      const x_css = x * dpr; 
      const y_css = y * dpr;
      
      const widthCSS = parseFloat(canvas.style.width || '0');
      const heightCSS = parseFloat(canvas.style.height || '0');
      
      if (x_css > currentW - margin || y_css > currentH - margin) {
          // If we are near the edge, grow by 600 CSS pixels
          const newW_CSS = x_css > currentW - margin ? widthCSS + 600 : widthCSS;
          const newH_CSS = y_css > currentH - margin ? heightCSS + 600 : heightCSS;
          
          const newW_DPR = Math.floor(newW_CSS * dpr);
          const newH_DPR = Math.floor(newH_CSS * dpr);
          
          if (newW_DPR > currentW || newH_DPR > currentH) {
              grew = true;
              
              const temp = document.createElement('canvas');
              temp.width = newW_DPR;
              temp.height = newH_DPR;
              const tctx = temp.getContext('2d')!;
              tctx.scale(dpr, dpr);
              
              // fill bg in the temporary canvas
              tctx.fillStyle = dark ? '#000' : '#fff';
              tctx.fillRect(0, 0, newW_CSS, newH_CSS);
              
              // draw old content
              tctx.drawImage(canvas, 0, 0);
              
              // Update main canvas dimensions and style
              canvas.width = temp.width;
              canvas.height = temp.height;
              canvas.style.width = `${newW_CSS}px`;
              canvas.style.height = `${newH_CSS}px`;
              
              // Draw temporary canvas back to main canvas (resetting transform first)
              const c2 = canvas.getContext('2d')!;
              c2.setTransform(1, 0, 0, 1, 0, 0);
              c2.scale(dpr, dpr);
              c2.drawImage(temp, 0, 0);
          }
      }
      
      if (grew) {
        // reapply transform after dimension change
        const tr = transformRef.current;
        ctx.setTransform(tr.scale, 0, 0, tr.scale, tr.offsetX, tr.offsetY);
      }
    };


    // For shapes: snapshot before drawing preview
    const snapshotCanvas = () => {
      const widthDPR = canvas.width;
      const heightDPR = canvas.height;
      
      // Temporarily remove transform to get the raw pixel data
      const tr = ctx.getTransform();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const snap = ctx.getImageData(0, 0, widthDPR, heightDPR);
      // Restore transform
      ctx.setTransform(tr);
      return snap;
    };
    const restoreSnapshot = (snap: ImageData) => {
      // Temporarily remove transform to restore raw pixel data
      const tr = ctx.getTransform();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.putImageData(snap, 0, 0);
      // Restore transform
      ctx.setTransform(tr);
    };

    const onPointerDown = (e: PointerEvent) => {
      // Only respond to pen or primary mouse button
      if (e.pointerType !== 'pen' && (e.pointerType !== 'mouse' || e.button !== 0)) return; 
      
      const p_world = toWorld(e.clientX, e.clientY);
      const p_screen = toScreen(p_world.x, p_world.y);
      
      ensureCapacity(p_screen.x, p_screen.y);
      setCursorPos(p_screen);
      pushUndo();
      
      if (mode === 'pen' || mode === 'eraser') {
        isDrawingRef.current = true;
        lastPosRef.current = p_world;
        ctx.globalCompositeOperation = mode === 'eraser' ? 'destination-out' : 'source-over';
        ctx.strokeStyle = color;
        // Use a base thickness, influenced by pressure if available
        const baseThickness = thickness / dpr; 
        const pressureFactor = (e.pressure === 0 || e.pressure === 1) ? 1 : e.pressure * 2;
        ctx.lineWidth = baseThickness * pressureFactor;
        
        ctx.beginPath();
        ctx.moveTo(p_world.x, p_world.y);
      } else {
        shapeStartRef.current = p_world;
        // Take snapshot in DPR pixels
        snapshotRef.current = snapshotCanvas();
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType !== 'pen' && e.pointerType !== 'mouse') return;
      
      const p_world = toWorld(e.clientX, e.clientY);
      const p_screen = toScreen(p_world.x, p_world.y);
      ensureCapacity(p_screen.x, p_screen.y);
      setCursorPos(p_screen);

      if (mode === 'pen' || mode === 'eraser') {
        if (!isDrawingRef.current) return;
        const baseThickness = thickness / dpr; 
        const pressureFactor = (e.pressure === 0 || e.pressure === 1) ? 1 : e.pressure * 2;
        ctx.lineWidth = baseThickness * pressureFactor;
        
        ctx.lineTo(p_world.x, p_world.y);
        ctx.stroke();
        lastPosRef.current = p_world;
      } else if (shapeStartRef.current && snapshotRef.current) {
        restoreSnapshot(snapshotRef.current);
        ctx.strokeStyle = color;
        ctx.lineWidth = thickness / dpr; // Apply thickness adjusted for DPR
        
        const a = shapeStartRef.current;
        if (mode === 'line') {
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(p_world.x, p_world.y);
          ctx.stroke();
        }
        if (mode === 'rectangle') {
          const w = p_world.x - a.x;
          const h = p_world.y - a.y;
          ctx.strokeRect(a.x, a.y, w, h);
        }
        if (mode === 'circle') {
          const r = Math.hypot(p_world.x - a.x, p_world.y - a.y);
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
  }, [color, thickness, mode, dark, pushUndo, setCursorPos, dpr]);

  // MATHJAX loader
  useEffect(() => {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/mathjax/2.7.9/MathJax.js?config=TeX-MML-AM_CHTML';
    script.async = true;
    document.head.appendChild(script);
    script.onload = () => {
      if (window.MathJax) {
        // FIX: Explicitly cast to 'any' to satisfy ESLint
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

  // Speech Recognition initialization
  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      if (!recognitionRef.current) {
        recognitionRef.current = new SpeechRecognition();
        recognitionRef.current.continuous = false;
        recognitionRef.current.interimResults = false;

        recognitionRef.current.onresult = (event) => {
          const transcript = event.results[0][0].transcript;
          setQuery(transcript);
          setIsListening(false);
        };
        recognitionRef.current.onerror = (event) => {
          console.error("Speech recognition error:", event.error);
          setIsListening(false);
        };
        recognitionRef.current.onend = () => {
          setIsListening(false);
        };
      }
      recognitionRef.current.lang = selectedLanguage;
    }
  }, [selectedLanguage]);

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
        // Store image data for backend processing instead of drawing on canvas
        const imageData = reader.result as string;

        // history
        const item: HistoryItem = {
          id: Date.now() + '_img',
          type: 'image',
          imageName: f.name,
          // thumbnail: imageData, // Removed to prevent localStorage quota issues
          createdAt: Date.now(),
        };
        const newH = [item, ...history];
        setHistory(newH);
        try {
          // Limit history to last 10 items to prevent localStorage quota issues
          const limitedHistory = newH.slice(0, 10);
          localStorage.setItem('neuron_history_v1', JSON.stringify(limitedHistory));
        } catch (error) {
          console.warn('Failed to save history to localStorage:', error);
        }

        // Automatically trigger calculation with the uploaded image
        runCalculationWithImage(imageData);
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(f);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // MICROPHONE (NOW FOR SPEECH RECOGNITION)
  const toggleMic = () => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  };

  // Speech Recognition functions
  const startListening = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert("Speech Recognition API is not supported in this browser.");
      return;
    }
    if (recognitionRef.current) {
      recognitionRef.current.start();
      setIsListening(true);
    }
  };

  const stopListening = () => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      setIsListening(false);
    }
  };

  // RUN calculation with uploaded image
  const runCalculationWithImage = useCallback(async (imageData: string) => {
    setLoading(true);

    try {
      const payload: Record<string, unknown> = {
        dict_of_vars: dictOfVars,
        image: imageData,
      };

      const response = await axios.post<{data: CalculationResponse[]}>(
        `${API_URL}/calculate`,
        payload,
        { timeout: 300000 } // Increased timeout to 5 minutes for image processing
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
        // Structure steps: detect if algorithmic (numbered) or general (bulleted)
        let structuredSteps = sol.steps && sol.steps.length ? sol.steps : ['(No steps provided)'];
        const isAlgorithmic = structuredSteps.some(step => /^\d+\./.test(step.trim()));
        if (isAlgorithmic) {
          structuredSteps = structuredSteps.map((step, i) => `${i + 1}. ${step}`);
        } else {
          structuredSteps = structuredSteps.map(step => `• ${step}`);
        }

        // Check if the expression appears to be a math expression
        const isMath = /[\d+\-*/=xXyYzZ^()]/.test(sol.expression);
        let latex: string;
        if (isMath) {
          latex = `\\[\\LARGE ${escapeHtml(sol.expression.replace(/ /g, '~'))} \\\\ ${escapeHtml(String(sol.answer).replace(/ /g, '~'))} \\\\ ${structuredSteps.map(s => escapeHtml(s.replace(/ /g, '~'))).join(' \\\\ ')} \\]`;
        } else {
          // For text responses, render as plain HTML to ensure readability in any language
          latex = `<div style="font-size: 16px; line-height: 1.5; font-family: Arial, sans-serif;"><strong>${escapeHtml(sol.expression)}</strong><br>${escapeHtml(String(sol.answer))}<br>${structuredSteps.map(s => escapeHtml(s)).join('<br>')}</div>`;
        }
        newLatex.push(latex);
        // Stagger positions with more vertical spacing to avoid overlap
        newPositions.push({ x: Math.max(50, Math.min(120 + idx * 10, window.innerWidth - 400)), y: 200 + idx * 200 });

        const item: HistoryItem = {
          id: Date.now() + '_sol_' + idx,
          type: 'solution',
          expression: sol.expression,
          answer: String(sol.answer),
          steps: structuredSteps,
          thumbnail: imageData,
          createdAt: Date.now(),
        };
        newHistory.push(item);
      });

      setLatexExpression((prev) => [...prev, ...newLatex]);
      setLatexPositions((prev) => [...prev, ...newPositions]);
      const mergedHistory = [...newHistory, ...history];
      setHistory(mergedHistory);
      try {
        // Limit history to last 10 items to prevent localStorage quota issues
        const limitedHistory = mergedHistory.slice(0, 10);
        localStorage.setItem('neuron_history_v1', JSON.stringify(limitedHistory));
      } catch (error) {
        console.warn('Failed to save history to localStorage:', error);
      }
    } catch (error) {
      console.error('Backend calculation failed:', error);
      alert('Image analysis failed. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [dictOfVars, history]);

  // RUN calculation: send text or canvas → backend; else try local
  const runCalculation = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    setLoading(true);
    const currentQuery = query.trim();
    setQuery(''); // Clear the text area

    // Prefer backend
    try {
      const payload: Record<string, unknown> = {
        dict_of_vars: dictOfVars,
        language_code: selectedLanguage,
      };
      let centerX = 120;
      let centerY = 200;
      
      // --- 1. Text Query Mode ---
      if (currentQuery) {
        payload.text = currentQuery;
      }
      
      // --- 3. Canvas Image Mode ---
      else {
        // ... (existing canvas crop/scale logic remains)
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        
        const currentTransform = ctx.getTransform();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        ctx.setTransform(currentTransform);

        let minX = canvas.width, minY = canvas.height, maxX = 0, maxY = 0;
        let hasDrawing = false;

        for (let y = 0; y < canvas.height; y++) {
          for (let x = 0; x < canvas.width; x++) {
            const i = (y * canvas.width + x) * 4;
            if (imageData.data[i + 3] > 0) {
              minX = Math.min(minX, x);
              minY = Math.min(minY, y);
              maxX = Math.max(maxX, x);
              maxY = Math.max(maxY, y);
              hasDrawing = true;
            }
          }
        }

        if (hasDrawing) {
          const PADDING_DPR = 20 * dpr; 
          
          minX = Math.max(0, minX - PADDING_DPR);
          minY = Math.max(0, minY - PADDING_DPR);
          maxX = Math.min(canvas.width, maxX + PADDING_DPR);
          maxY = Math.min(canvas.height, maxY + PADDING_DPR);
          
          const croppedWidth = maxX - minX;
          const croppedHeight = maxY - minY;
          
          const croppedCanvas = document.createElement('canvas');
          croppedCanvas.width = croppedWidth;
          croppedCanvas.height = croppedHeight;
          const croppedCtx = croppedCanvas.getContext('2d');
          
          if (croppedCtx) {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            croppedCtx.drawImage(
              canvas,
              minX, minY, croppedWidth, croppedHeight,
              0, 0, croppedWidth, croppedHeight
            );
            ctx.setTransform(currentTransform);

            // --- OCR ACCURACY FIX: INVERT COLORS IF IN DARK MODE ---
            if (dark) {
              const croppedImageData = croppedCtx.getImageData(0, 0, croppedWidth, croppedHeight);
              const data = croppedImageData.data;
              
              for (let i = 0; i < data.length; i += 4) {
                if (data[i + 3] > 0) {
                  data[i] = 255 - data[i];
                  data[i + 1] = 255 - data[i + 1];
                  data[i + 2] = 255 - data[i + 2];
                }
              }
              croppedCtx.putImageData(croppedImageData, 0, 0);
              console.log("INFO: Dark mode drawing colors inverted for OCR/VLM contrast.");
            }
            // --- END OCR ACCURACY FIX ---
            
            // --- Scale up while preserving aspect ratio for VLM/OCR ---
            const scaledCanvas = document.createElement('canvas');
            scaledCanvas.width = TARGET_VLM_SIZE;
            scaledCanvas.height = TARGET_VLM_SIZE;
            const scaledCtx = scaledCanvas.getContext('2d');
            
            if (scaledCtx) {
              const ratio = Math.min(TARGET_VLM_SIZE / croppedWidth, TARGET_VLM_SIZE / croppedHeight);
              const drawWidth = croppedWidth * ratio;
              const drawHeight = croppedHeight * ratio;
              const drawX = (TARGET_VLM_SIZE - drawWidth) / 2;
              const drawY = (TARGET_VLM_SIZE - drawHeight) / 2;
              
              scaledCtx.fillStyle = '#ffffff'; 
              scaledCtx.fillRect(0, 0, TARGET_VLM_SIZE, TARGET_VLM_SIZE);
              
              scaledCtx.drawImage(
                croppedCanvas, 
                0, 0, croppedWidth, croppedHeight,
                drawX, drawY, drawWidth, drawHeight
              );
              
              payload.image = scaledCanvas.toDataURL('image/png');
            } else {
              payload.image = croppedCanvas.toDataURL('image/png');
            }
          } else {
            payload.image = canvas.toDataURL('image/png');
          }

          const t = transformRef.current;
          const centerWorldX = (minX + maxX) / 2;
          const centerWorldY = (minY + maxY) / 2;
          
          centerX = ((centerWorldX / dpr) * t.scale + t.offsetX / dpr);
          centerY = ((centerWorldY / dpr) * t.scale + t.offsetY / dpr);
          
        } else {
          // If canvas is blank, only continue if text was provided
          if (currentQuery) {
            // Do nothing, payload will contain text
          } else {
            payload.image = canvas.toDataURL('image/png');
          }
        }
      }
      
      // Only proceed if we have text or image to send
      if (payload.text || payload.image) {

          // --- 4. Backend Call ---
          const response = await axios.post<{data: CalculationResponse[]}>(
            `${API_URL}/calculate`,
            payload,
            { timeout: 300000 } // Increased timeout to 5 minutes for image processing
          );

          const resp = response.data;
          console.log('Backend response:', resp); // Debug log for response

          const newVars: Record<string, string> = {};
          const solutions: GeneratedResult[] = [];

          if (!resp.data || !Array.isArray(resp.data)) {
            console.error('Invalid response data:', resp);
            alert('Invalid response from server. Please try again.');
            return;
          }

          resp.data.forEach((r) => {
            if (r.assign) newVars[r.expr] = r.result;
            solutions.push({
              expression: r.expr,
              answer: r.result,
              steps: r.steps && r.steps.length ? r.steps : trySolveLocally(r.expr)?.steps,
            });
          });

          if (solutions.length === 0) {
            console.warn('No solutions generated from response.');
            alert('No solutions generated. Please check your input.');
            return;
          }

          setDictOfVars((prev) => ({ ...prev, ...newVars }));

          // Render LaTeX + History
          console.time('Rendering LaTeX and History'); // Performance logging start
          const newLatex: string[] = [];
          const newPositions: LatexPosition[] = [];
          const newHistory: HistoryItem[] = [];

      solutions.forEach((sol, idx) => {
        // Structure steps: detect if algorithmic (numbered) or general (bulleted)
        let structuredSteps = sol.steps && sol.steps.length ? sol.steps : ['(No steps provided)'];
        const isAlgorithmic = structuredSteps.some(step => /^\d+\./.test(step.trim()));
        if (isAlgorithmic) {
          structuredSteps = structuredSteps.map((step, i) => `${i + 1}. ${step}`);
        } else {
          structuredSteps = structuredSteps.map(step => `• ${step}`);
        }

        // For image responses, prefer HTML rendering to avoid slow MathJax
        let latex: string;
        if (payload.image) {
          // Always use HTML for sketch-to-text to improve performance
          latex = `<div style="font-size: 16px; line-height: 1.5; font-family: Arial, sans-serif;"><strong>${escapeHtml(sol.expression)}</strong><br>${escapeHtml(String(sol.answer))}<br>${structuredSteps.map(s => escapeHtml(s)).join('<br>')}</div>`;
        } else {
          // Check if the expression appears to be a math expression
          const isMath = /[\d+\-*/=xXyYzZ^()]/.test(sol.expression);
          if (isMath) {
            latex = `\\[\\LARGE ${escapeHtml(sol.expression.replace(/ /g, '~'))} \\\\ ${escapeHtml(String(sol.answer).replace(/ /g, '~'))} \\\\ ${structuredSteps.map(s => escapeHtml(s.replace(/ /g, '~'))).join(' \\\\ ')} \\]`;
          } else {
            // For text responses, render as plain HTML to ensure readability in any language
            latex = `<div style="font-size: 16px; line-height: 1.5; font-family: Arial, sans-serif;"><strong>${escapeHtml(sol.expression)}</strong><br>${escapeHtml(String(sol.answer))}<br>${structuredSteps.map(s => escapeHtml(s)).join('<br>')}</div>`;
          }
        }
        newLatex.push(latex);
        // Stagger positions with more vertical spacing to avoid overlap
        newPositions.push({ x: Math.max(50, Math.min(centerX + idx * 10, window.innerWidth - 400)), y: centerY + idx * 200 });

        const item: HistoryItem = {
          id: Date.now() + '_sol_' + idx,
          type: 'solution',
          expression: sol.expression,
          answer: String(sol.answer),
          steps: structuredSteps,
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
            // Limit history to last 10 items to prevent localStorage quota issues
            const limitedHistory = mergedHistory.slice(0, 10);
            localStorage.setItem('neuron_history_v1', JSON.stringify(limitedHistory));
          } catch (error) {
            console.warn('Failed to save history to localStorage:', error);
          }
          console.timeEnd('Rendering LaTeX and History'); // Performance logging end
          setLoading(false); // Ensure loading is turned off after successful processing
          return;
      }
      
    } catch (error) {
      console.error('Backend calculation failed:', error);
      // Fallback below
    } finally {
      setLoading(false);
    }

    // --- 5. Local Fallback (Only for explicit text query) ---
    if (currentQuery) {
      const local = trySolveLocally(currentQuery);
      if (local) {
        const canvasUrl = canvas.toDataURL();
        // Structure steps for local fallback
        let structuredSteps = local.steps && local.steps.length ? local.steps : ['(No steps provided)'];
        const isAlgorithmic = structuredSteps.some(step => /^\d+\./.test(step.trim()));
        if (isAlgorithmic) {
          structuredSteps = structuredSteps.map((step, i) => `${i + 1}. ${step}`);
        } else {
          structuredSteps = structuredSteps.map(step => `• ${step}`);
        }

        // Check if the expression appears to be a math expression
        const isMath = /[\d+\-*/=xXyYzZ^()]/.test(local.expression);
        let latex: string;
        if (isMath) {
          latex = `\\[\\LARGE ${escapeHtml(local.expression.replace(/ /g, '~'))} \\\\ ${escapeHtml(local.answer.replace(/ /g, '~'))} \\\\ ${structuredSteps.map(s => escapeHtml(s.replace(/ /g, '~'))).join(' \\\\ ')} \\]`;
        } else {
          // For text responses, render as plain HTML to ensure readability in any language
          latex = `<div style="font-size: 16px; line-height: 1.5; font-family: Arial, sans-serif;"><strong>${escapeHtml(local.expression)}</strong><br>${escapeHtml(local.answer)}<br>${structuredSteps.map(s => escapeHtml(s)).join('<br>')}</div>`;
        }
        setLatexExpression((prev) => [...prev, latex]);
        setLatexPositions((prev) => [...prev, { x: 120, y: 200 + prev.length * 200 }]);

        const item: HistoryItem = {
          id: Date.now() + '_sol_local',
          type: 'solution',
          expression: local.expression,
          answer: local.answer,
          steps: structuredSteps,
          thumbnail: canvasUrl,
          createdAt: Date.now(),
        };
        const newH = [item, ...history];
        setHistory(newH);
        try {
          // Limit history to last 10 items to prevent localStorage quota issues
          const limitedHistory = newH.slice(0, 10);
          localStorage.setItem('neuron_history_v1', JSON.stringify(limitedHistory));
        } catch (error) {
          console.warn('Failed to save history to localStorage:', error);
        }
        return;
      }
    }

    alert('No input detected (Canvas blank, no text).');
    setLoading(false);
  }, [dictOfVars, history, query, dpr, dark]);


  // THEME toggle
  const toggleTheme = () => setColorScheme(dark ? 'light' : 'dark');

  
  // Custom cursor size based on current tool and thickness
  const getCursorSize = useCallback(() => {
    // Cursor should scale inversely with canvas zoom so it always appears the same size on screen
    const { scale } = transformRef.current;
    if (mode === 'eraser') return (thickness * 8) / scale;
    if (mode === 'pen') return (thickness * 2) / scale;
    return 16 / scale; // Default size for shape tools
  }, [mode, thickness]);

  // Memo cursor position to avoid unnecessary re-renders
  const cursorStyle = useMemo(() => {
    if (!cursorPos) return null;
    const { scale } = transformRef.current;
    const size = getCursorSize();
    
    // Cursor position is already calculated in CSS pixels
    const screenX = cursorPos.x;
    const screenY = cursorPos.y;
    
    return {
      position: 'absolute',
      left: screenX - size / 2, // Center cursor on the position
      top: screenY - size / 2, // Center cursor on the position
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
      transform: `scale(${scale})`, // Remove inverse scale
    } as const;
  }, [cursorPos, mode, getCursorSize]); 

  // UI
  return (
      <Box
        className="w-full h-full"
        style={{
          background: dark ? '#101010ff' : '#fff',
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
            AI
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
          {/* Profile Icon with Dropdown */}
          {user && (
            <Menu shadow="md" width={200}>
              <Menu.Target>
                <ActionIcon variant="subtle" size="lg" aria-label="User menu">
                  <User size={20} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>Welcome, {user.username}</Menu.Label>
                <Menu.Divider />
                <Menu.Item leftSection={<LogOut size={14} />} onClick={logout}>
                  Logout
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          )}
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
            overflow: 'auto', // Enable infinite scroll
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
                // Use mixBlendMode to make sure text stands out on any background
                mixBlendMode: dark ? 'screen' : 'multiply',
                background: 'transparent',
                userSelect: 'none',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                overflowWrap: 'break-word',
                maxWidth: '80vw',
                fontSize: '14px',
                textAlign: 'justify',
                textJustify: 'inter-word',
                lineHeight: '1.5',
                wordSpacing: '0.1em',
                overflow: 'auto', // Enable scrolling for long content
                maxHeight: '60vh', // Limit height to prevent overflow
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
            <Tooltip label={isListening ? 'Stop listening' : 'Start speech recognition'}>
              <ActionIcon
                size="lg"
                variant="light"
                onClick={toggleMic}
                aria-label="Speech Recognition"
                color={isListening ? 'red' : 'blue'}
                disabled={loading}
              >
                <Mic size={24} style={{ color: isListening ? '#ef4444' : undefined }} />
              </ActionIcon>
            </Tooltip>
            <Select
              placeholder="Language"
              data={[
                { value: 'en-US', label: 'English (US)' },
                { value: 'en-GB', label: 'English (UK)' },
                { value: 'kn-IN', label: 'Kannada (India)' },
                { value: 'hi-IN', label: 'Hindi (India)' },
                { value: 'te-IN', label: 'Telugu (India)' },
                { value: 'ta-IN', label: 'Tamil (India)' },
              ]}
              value={selectedLanguage}
              onChange={(value) => setSelectedLanguage(value || 'en-US')}
              style={{ width: 150 }}
              disabled={loading || isListening}
              styles={{
                input: { color: dark ? '#fff' : '#000', backgroundColor: dark ? '#333' : '#fff' },
                dropdown: { backgroundColor: dark ? '#333' : '#fff' },
                option: { color: dark ? '#fff' : '#000' },
              }}
            />
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
            <MantineButton onClick={() => runCalculation()} variant="light" leftSection={<Send size={16} />} loading={loading}>
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
                      boxShadow: '0 2px 8px rgba(230, 38, 38, 0.08)',
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
                            <Text key={i} size="sm">{s}</Text>
                          ))}
                        </Stack>
                      </>
                    )}
                    {h.type === 'audio' && h.audioUrl && (
                      <Box mt="sm">
                        <audio controls src={h.audioUrl} style={{ width: '100%' }} />
                        <Text size="xs" mt={4}>
                            {h.audioSent ? 'Processing audio via backend...' : 'Audio ready for local playback.'}
                        </Text>
                      </Box>
                    )}
                    {h.type === 'image' && h.imageName && (
                      <Box mt="sm">
                        <Text size="sm">Uploaded: {h.imageName}</Text>
                        {/* Thumbnail removed to prevent localStorage quota issues */}
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