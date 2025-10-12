# TODO: Adapt Drawing Logic to Simpler Mouse Events

## 1. Remove Pointer Event Handlers
- [x] Remove pointer event listeners (pointerdown, pointermove, pointerup, pointerenter, pointerleave)
- [x] Remove handlePointerDown, handlePointerMove, handlePointerUp functions
- [x] Remove isDrawingRef and lastPosRef usage for pointer events

## 2. Add Mouse Event Handlers
- [x] Add onMouseDown, onMouseMove, onMouseUp, onMouseOut handlers on canvas element
- [x] Implement startDrawing, draw, stopDrawing functions using current color and thickness

## 3. Keep Other Features Intact
- [x] Preserve pan/zoom functionality
- [x] Keep text input and LaTeX rendering
- [x] Maintain undo/redo, save/load sessions
- [x] Retain shape drawing and other tools

## 4. Test Functionality
- [ ] Test basic drawing with pen tool
- [ ] Verify color and thickness changes
- [ ] Check pan/zoom still works
- [ ] Ensure text input and other features function
