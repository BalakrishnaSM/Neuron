# Frontend Fixes and Cursor Function Update

## Tasks:
- [x] Fix ESLint error: Remove unused 'createWorker' import from calc-fe-main/src/screens/home/index.tsx
- [ ] Update cursor function based on pseudocode:
  - [ ] Remove cursorPos state
  - [ ] Remove setCursorPos calls in pointermove
  - [ ] Remove cursorStyle memo
  - [ ] Remove custom cursor div
  - [ ] Remove cursor: 'none' from canvas style
- [ ] Run lint to verify no errors
- [ ] Test drawing functionality

## Backend OCR Improvement
- [x] Replace pytesseract with easyocr for better OCR performance in calc-be-main/app.py
- [ ] Test OCR functionality with sample images
