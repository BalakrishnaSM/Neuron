from flask import Flask, request, jsonify
from flask_cors import CORS
import os
import json
import ast
import base64
import cv2
import numpy as np
import pytesseract
import re

# --- Configuration & Initialization ---

# 1. Configure pytesseract path and availability flag
TESSERACT_AVAILABLE = False
try:
    # Attempt to use Tesseract from a common default path
    tesseract_cmd = os.environ.get(
        "TESSERACT_CMD",
        r'C:\Program Files\Tesseract-OCR\tesseract.exe'
    )
    # Check for Tesseract's existence
    if os.path.exists(tesseract_cmd) or tesseract_cmd == 'tesseract':
        pytesseract.pytesseract.tesseract_cmd = tesseract_cmd
        TESSERACT_AVAILABLE = True
except Exception:
    # This block handles any general initialization error for pytesseract
    print("Warning: pytesseract could not be configured or Tesseract not found. OCR will be disabled.")

# 2. LangChain + Ollama Setup
from langchain_ollama import OllamaLLM, ChatOllama
from langchain_core.messages import HumanMessage

# Using your available models: gemma3 for text/math and moondream for vision
OLLAMA_TEXT_MODEL = os.getenv("OLLAMA_TEXT_MODEL", "gemma3:latest")
OLLAMA_VISION_MODEL = os.getenv("OLLAMA_VISION_MODEL", "moondream:latest")

# Initialize Flask app
app = Flask(__name__)
CORS(app, resources={r"/calculate": {"origins": "*"}})

# Initialize Ollama LLM for text/math and ChatOllama for multimodal vision
try:
    llm = OllamaLLM(model=OLLAMA_TEXT_MODEL)
    chat = ChatOllama(model=OLLAMA_VISION_MODEL)
    print(f"Ollama models initialized: Text={OLLAMA_TEXT_MODEL}, Vision={OLLAMA_VISION_MODEL}")
except Exception as e:
    print(f"Error initializing Ollama models. Ensure Ollama is running and models are pulled: {e}")
    # Define placeholder functions for error scenario
    llm = lambda x: '{"error": "Ollama text model not available"}'
    
    class MockChat:
        def invoke(self, messages):
            return type('MockResponse', (object,), {'content': '[{"expr": "Error: Ollama Vision model not available", "result": "Check Ollama server and model pull.", "assign": false}]'})()
    chat = MockChat()


# --- Utility Functions ---

def preprocess_text(text: str) -> str:
    """Adds spaces around operators and normalizes text for better LLM parsing."""
    if not text:
        return ""
    
    # Add spaces between digits and letters (e.g., '3x' -> '3 x')
    text = re.sub(r'(\d)([a-zA-Z])', r'\1 \2', text)
    text = re.sub(r'([a-zA-Z])(\d)', r'\1 \2', text)
    # Add spaces around common math symbols
    text = re.sub(r'([+\-*/=^()<>])', r' \1 ', text)
    # Normalize whitespace
    text = re.sub(r'([^\S\r\n]+)', ' ', text).strip()
    return text

def decode_image_and_ocr(image_data_b64: str) -> tuple[str, str]:
    """Decodes base64 image, runs Tesseract OCR if available, and returns OCR text and raw base64 data."""
    
    # Extract raw base64 data regardless of prefix
    raw_b64_data = image_data_b64.split(',')[1] if image_data_b64.startswith('data:image/png;base64,') else image_data_b64
    
    if not TESSERACT_AVAILABLE:
        return "", raw_b64_data

    try:
        # Decode base64
        image_bytes = base64.b64decode(raw_b64_data)
        np_arr = np.frombuffer(image_bytes, np.uint8)
        img = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

        if img is None:
            return "", raw_b64_data

        # Pre-process for better OCR
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        # Use simple thresholding for high contrast drawings
        _, binary = cv2.threshold(gray, 150, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        
        # Run Tesseract OCR (PSM 6: Assume a single uniform block of text)
        config = r'--psm 6' 
        ocr_text = pytesseract.image_to_string(binary, config=config).strip()
        
        return ocr_text, raw_b64_data
    
    except Exception as e:
        print(f"Error during image decoding or OCR: {e}")
        # Return empty text but the raw b64 data for VLM fallback
        return "", raw_b64_data


# --- API Endpoint ---
@app.route("/calculate", methods=["POST"])
def calculate():
    """
    Receives text or image data from the frontend and uses an LLM (Gemma) 
    or VLM (moondream) to solve math/interpret the image.
    """
    try:
        data = request.json
        if not data:
            return jsonify({"error": "No JSON data provided"}), 400

        text = data.get("text", "").strip()
        image_data = data.get("image", "")
        dict_of_vars = data.get("dict_of_vars", {})
        
        final_text_input = text
        
        # --- 1. Image/Drawing Handling ---
        if image_data:
            print("Received image data. Processing...")
            
            # Run server-side OCR on the image. Always returns raw_b64_data.
            ocr_result, raw_b64_data = decode_image_and_ocr(image_data)
            
            ocr_is_valid = False
            # If Tesseract is available AND it produced a result, validate it strictly.
            if TESSERACT_AVAILABLE and ocr_result:
                
                # CRITICAL: Strict validation for math input to bypass garbage.
                # Must contain at least one operator/variable AND be a reasonable length.
                min_valid_length = 10 # Adjusted slightly lower, but still relies on context
                has_math_symbol = any(sym in ocr_result.lower() for sym in ['x', 'y', 'z', '=', '+', '-', '*', '/', '^'])
                
                if len(ocr_result) >= min_valid_length and has_math_symbol:
                    # If it's long AND has a math symbol, we grudgingly trust Tesseract for now.
                    final_text_input = ocr_result
                    ocr_is_valid = True
                    print(f"✅ OCR successful and valid (length > {min_valid_length} & has symbol). Text: '{final_text_input}'")
                else:
                    # Short, garbage, or missing math symbol -> FORCING VLM
                    print(f"⚠️ OCR failed strict math validation ('{ocr_result}'). Forcing Multimodal (Vision) model.")
            
            # --- FALLBACK TO MULTIMODAL (VLM) ---
            if not ocr_is_valid:
                
                dict_of_vars_str = json.dumps(dict_of_vars, ensure_ascii=False)
                
                # Final, optimized prompt for moondream (Extremely strict on output)
                prompt = (
                    f"You are an intelligent educational AI assistant called **Neuron**.\n"
                    f"Your sole purpose is to analyze the image and return a JSON list containing the result of the primary content shown in the image. **DO NOT INCLUDE ANY EXTRA DICTIONARIES OR EXAMPLE DICTIONARIES**.\n"
                    f"\n"
                    f"🎓 Your tasks include:\n"
                    f"1. **Solving math/numericals** from figures or equations.\n"
                    f"2. **Interpreting diagrams/concepts** (e.g., physics, chemistry, civic issues).\n"
                    f"\n"
                    f"Follow these strict instructions for the response:\n"
                    f"➤ Return a **list containing EXACTLY ONE Python dictionary**, with keys: `expr`, `result`, and `assign`.\n"
                    f"➤ **CRITICAL**: ACCURATELY TRANSCRIBE AND SOLVE THE CONTENT SHOWN IN THE IMAGE. **DO NOT INVENT OPERATORS OR SYMBOLS** (like '=' or 'x'). The 'expr' must only contain the symbols VISIBLE in the image.\n"
                    f"➤ Use **double quotes only** for all keys and string values.\n"
                    f"➤ The final output MUST be a valid, un-truncated Python list object (e.g., `[...]`).\n"
                    f"\n"
                    f"**REQUIRED OUTPUT FORMAT EXAMPLES (Follow this structure precisely, but return only ONE dictionary):**\n"
                    f"1. **Arithmetic Example (for 3+7):** `[{{\"expr\": \"3 + 7\", \"result\": 10, \"assign\": false}}]`\n"
                    f"2. **Interpretation Example:** `[{{\"expr\": \"Traffic jam\", \"result\": \"Traffic violation detected. Suggest police intervention.\", \"assign\": false}}]`\n"
                    f"\n"
                    f"🧮 Use this variable dictionary for replacements (if variables are present):\n{dict_of_vars_str}\n"
                    f"\n"
                    f"🔒 Output must be parsable via Python `ast.literal_eval()` and contain no markdown, no code blocks, and no text outside the list.\n"
                )
                
                # VLM requires the 'data:image/png;base64,' prefix
                b64_url = f"data:image/png;base64,{raw_b64_data}"
                
                message = HumanMessage(
                    content=[
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": b64_url}}
                    ]
                )
                
                try:
                    response = chat.invoke([message])
                    raw_response = response.content
                    print(f"Vision response (moondream): '{raw_response.strip()[:100]}...'")
                    
                    # Parse using ast.literal_eval for safety and then ensure 'assign' key exists
                    answers = ast.literal_eval(raw_response.strip())
                    
                    # Filter out extra dictionaries if the model failed to follow the EXACTLY ONE rule
                    if isinstance(answers, list) and len(answers) > 1:
                        answers = [answers[0]]
                        print("INFO: Filtered VLM response to keep only the first result.")


                    for answer in answers:
                        answer["assign"] = answer.get("assign", False)
                    
                    # CRUCIAL: Return immediately after VLM response
                    return jsonify({"data": answers})
                
                except Exception as e:
                    print(f"Error parsing vision response: {e}")
                    # Provide a generic error response for malformed VLM output
                    return jsonify({"data": [{"expr": "Image analysis failed", "result": "The vision model response was malformed. Please try again or simplify the drawing.", "assign": False}]}), 500

            # If OCR succeeded AND was valid, execution continues to LLM block (2)
            
        # --- 2. Text-only/OCR Text Handling (Gemma) ---
        
        # If text came from the request body or from successful/valid OCR
        if final_text_input:
            
            final_text_input = preprocess_text(final_text_input)
            print(f"Processing text with LLM: '{final_text_input}'")

            # Build math-specific prompt for Gemma
            dict_of_vars_str = ", ".join([f"{k}={v}" for k, v in dict_of_vars.items()]) if dict_of_vars else ""
            prompt_text = f"""Transcribe the math/equation in the text and solve it.
            
Output ONLY a JSON list of dictionaries like: [{{"expr": "expression", "result": "answer", "assign": false}}]

No other text or explanation.

Examples:
- 2 + 2 -> [{{"expr": "2 + 2", "result": "4"}}]
- x = 5 -> [{{"expr": "x", "result": "5", "assign": true}}]

Variables: {dict_of_vars_str}

Input: {final_text_input}"""

            # Call Gemma
            raw_response = llm.invoke(prompt_text)
            print(f"Raw LLM response (Gemma): {raw_response.strip()[:100]}...")

            # Clean and Parse the response
            raw_response = raw_response.strip()
            
            # Remove common code block wrappers
            if raw_response.startswith('```json') and raw_response.endswith('```'):
                raw_response = raw_response[7:-3].strip()
            elif raw_response.startswith('```') and raw_response.endswith('```'):
                raw_response = raw_response[3:-3].strip()

            try:
                # Use JSON loads for robust parsing of LLM output
                resp_data = json.loads(raw_response)
            except json.JSONDecodeError as jde:
                print(f"Error parsing LLM JSON: {jde}")
                # Fallback if not valid JSON
                resp_data = [{"expr": final_text_input, "result": "Could not parse the result, please check the expression.", "assign": False}]

            # Return structured response
            return jsonify({
                "data": resp_data
            })

        # --- 3. No Input Case ---
        return jsonify({"error": "Please provide an image or text for calculation/analysis."}), 400

    except Exception as e:
        print(f"An unexpected error occurred: {e}")
        return jsonify({"error": f"An internal server error occurred: {e}"}), 500


# --- Server Startup ---
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8900, debug=True)