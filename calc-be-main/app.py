from flask import Flask, request, jsonify
from flask_cors import CORS
from flask_jwt_extended import JWTManager, jwt_required, create_access_token, get_jwt_identity
import os
import json
import base64
import cv2
import numpy as np
import re
import easyocr
import io
import tempfile
import whisper
from langchain_ollama import OllamaLLM, ChatOllama
from langchain_core.messages import HumanMessage
import pyttsx3
from gtts import gTTS
import tempfile
# Assuming 'models' module exists and contains User, History
from models import User, History 

# --- Configuration & Initialization ---

# 1. Configure EasyOCR path and availability
EASYOCR_AVAILABLE = False
EASYOCR_READER = None
try:
    # EasyOCR for English and Math
    EASYOCR_READER = easyocr.Reader(['en'], gpu=False)
    EASYOCR_AVAILABLE = True
    print("EasyOCR configured successfully.")
except Exception as e:
    print(f"Warning: EasyOCR could not be configured: {e}")

# 2. Whisper ASR Setup (supports multiple languages)
WHISPER_MODEL = None
try:
    WHISPER_MODEL = whisper.load_model("base")  # Can be "tiny", "base", "small", "medium", "large"
    print("Whisper ASR model loaded successfully.")
except Exception as e:
    print(f"Warning: Whisper could not be loaded: {e}")

# 3. Ollama Setup
OLLAMA_TEXT_MODEL = os.getenv("OLLAMA_TEXT_MODEL", "qwen3-vl:2b")
OLLAMA_VISION_MODEL = os.getenv("OLLAMA_VISION_MODEL", "qwen3-vl:2b")

app = Flask(__name__)
app.config['JWT_SECRET_KEY'] = os.getenv('JWT_SECRET_KEY', 'your-secret-key-change-in-production')
jwt = JWTManager(app)
CORS(app, resources={r"/*": {"origins": "*"}})

# Initialize models
try:
    llm = OllamaLLM(model=OLLAMA_TEXT_MODEL)
    chat = ChatOllama(model=OLLAMA_VISION_MODEL)
    print(f"Ollama Models initialized: Text={OLLAMA_TEXT_MODEL}, Vision={OLLAMA_VISION_MODEL}")
except Exception as e:
    print(f"Ollama Model init failed: {e}")
    llm = lambda x: '{"expr": "LLM not available", "result": "Model initialization failed", "assign": false}'
    class MockChat:
        def invoke(self, messages):
            return type("MockResp", (object,), {
                "content": "[{\"expr\": \"Image analysis failed\", \"result\": \"Vision model not available\", \"assign\": false}]"
            })()
    chat = MockChat()

# TTS Engine
tts_engine = pyttsx3.init()

# --- Utility Functions ---

def transcribe_audio_whisper(audio_data_b64: str, language: str = "auto") -> str:
    """Uses Whisper to transcribe base64 encoded audio (audio/webm)."""
    if not WHISPER_MODEL:
        return ""

    transcription = ""
    temp_audio_path = None

    try:
        # Decode base64 audio
        raw_b64 = audio_data_b64.split(",")[1] if audio_data_b64.startswith("data:audio") else audio_data_b64
        audio_bytes = base64.b64decode(raw_b64)

        # Save to temporary file
        with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as temp_file:
            temp_file.write(audio_bytes)
            temp_audio_path = temp_file.name

        # Transcribe with Whisper
        if language == "auto":
            result = WHISPER_MODEL.transcribe(temp_audio_path)
        else:
            result = WHISPER_MODEL.transcribe(temp_audio_path, language=language)

        transcription = result["text"].strip()
        print(f"✅ Whisper transcription successful: '{transcription}'")

    except Exception as e:
        print(f"FATAL ASR ERROR: {e}")
        return ""
    finally:
        if temp_audio_path and os.path.exists(temp_audio_path):
            os.unlink(temp_audio_path)

    return transcription

def generate_tts_audio(text: str, language: str = "en") -> str:
    """Generates TTS audio and returns base64 encoded audio."""
    try:
        # Use gTTS for better multi-language support
        tts = gTTS(text=text, lang=language, slow=False)
        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as temp_file:
            tts.save(temp_file.name)
            temp_audio_path = temp_file.name

        # Read and encode to base64
        with open(temp_audio_path, "rb") as audio_file:
            audio_data = audio_file.read()
            audio_b64 = base64.b64encode(audio_data).decode('utf-8')

        os.unlink(temp_audio_path)
        return f"data:audio/mp3;base64,{audio_b64}"

    except Exception as e:
        print(f"TTS generation failed: {e}")
        return ""

def preprocess_text(text: str) -> str:
    """
    Aggressively corrects common OCR/ASR misreads of math symbols.
    """
    if not text:
        return ""

    text = text.replace(' ', '') 

    # Common digit/variable corrections 
    text = re.sub(r'[iIl]', '1', text) 
    text = re.sub(r'[OoQ]', '0', text)
    text = re.sub(r'[JSZ]', '2', text) 
    text = re.sub(r'(\d)[Ss]', r'\1+', text) 
    text = re.sub(r'[Tt]', '+', text) 
    text = re.sub(r'X', 'x', text) 

    # Add spaces around operators and normalize structure
    text = re.sub(r"([+\-*/=^()<>])", r" \1 ", text)
    text = re.sub(r"(\d)([a-zA-Z])", r"\1 \2", text)
    text = re.sub(r"([a-zA-Z])(\d)", r"\1 \2", text)
    
    return re.sub(r"[^\S\r\n]+", " ", text).strip()

def decode_image_and_ocr(image_data_b64: str) -> tuple[str, str]:
    """Decodes base64 image, runs EasyOCR."""
    raw_b64 = image_data_b64.split(",")[1] if image_data_b64.startswith("data:image") else image_data_b64
    
    if not EASYOCR_AVAILABLE:
        return "", raw_b64

    try:
        image_bytes = base64.b64decode(raw_b64)
        np_arr = np.frombuffer(image_bytes, np.uint8)
        
        img_np = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
        if img_np is None:
            return "", raw_b64

        results = EASYOCR_READER.readtext(img_np, detail=0)
        ocr_text = " ".join(results).strip()
        
        return ocr_text, raw_b64
    except Exception as e:
        print(f"EasyOCR runtime error: {e}")
        return "", raw_b64

def clean_model_response(raw_response: str) -> str:
    """
    Aggressively cleans LLM response to ensure JSON parsing success.
    """
    raw_response = raw_response.strip()
    
    if raw_response.startswith("```json") and raw_response.endswith("```"):
        raw_response = raw_response[7:-3].strip()
    elif raw_response.startswith("```") and raw_response.endswith("```"):
        raw_response = raw_response[3:-3].strip()

    start_match = re.search(r'(\[|\{)', raw_response, re.DOTALL)
    if not start_match:
        return raw_response
    
    start_index = start_match.start()
    trimmed_response = raw_response[start_index:].strip()

    if trimmed_response.startswith('{'):
        brace_count = 0
        end_index = -1
        for i, char in enumerate(trimmed_response):
            if char == '{': brace_count += 1
            elif char == '}': 
                brace_count -= 1
                if brace_count == 0:
                    end_index = i + 1
                    break
        
        if end_index > 0:
            print("WARNING: Injected JSON list wrapper and aggressively trimmed dictionary end.")
            return '[' + trimmed_response[:end_index] + ']'
            
    if trimmed_response.startswith('['):
        bracket_count = 0
        end_index = -1
        for i, char in enumerate(trimmed_response):
            if char == '[': bracket_count += 1
            elif char == ']': 
                bracket_count -= 1
                if bracket_count == 0:
                    end_index = i + 1
                    break
        
        if end_index > 0:
            return trimmed_response[:end_index]
            
    return trimmed_response

def post_process_vlm_output(answers: list, llm_instance: OllamaLLM) -> list:
    """
    Analyzes VLM output for simple arithmetic that should have been an equation
    and uses the powerful LLM (Gemma) for correction.
    """
    if not answers or not isinstance(answers, list) or "expr" not in answers[0] or callable(llm_instance):
        return answers
    
    primary = answers[0]
    expr = str(primary.get("expr", "")).lower().strip()
    result = str(primary.get("result", "")).lower().strip()

    is_arithmetic_guess = (
        not any(v in expr for v in ["x", "y", "z", "="]) and 
        any(op in expr for op in ["+", "-", "*", "/"]) and
        not any(keyword in result for keyword in ["suggest", "violation", "detected", "explain", "concept"])
    )
    is_error_to_check = ("failed" in result.lower() or "not available" in result.lower()) and any(c.isdigit() for c in expr)
    
    if is_arithmetic_guess or is_error_to_check:
        print("INFO: VLM simple arithmetic/error detected. Re-routing transcription attempt to LLM for correction.")
        
        expr_to_solve = primary.get("expr", "").strip()
        
        guess_prompt = (
            f"Solve the simple arithmetic/equation expression: '{expr_to_solve}'. "
            f"If the input is not a math problem, set 'result' to a brief explanation of the input (e.g., 'A logo')."
            f"Output ONLY a JSON list of dictionaries like: [{{'expr': 'expression','result': 'answer','assign': false}}]\n"
            f"Input: {expr_to_solve}"
        )
        
        try:
            raw_response = llm_instance.invoke(guess_prompt).strip() 
            raw_response = clean_model_response(raw_response)

            corrected = json.loads(raw_response)
            
            if corrected and isinstance(corrected, list) and 'result' in corrected[0]:
                print(f"INFO: LLM correction applied. New result: {corrected[0]['result']}")
                return [corrected[0]] 

        except Exception as e:
            print(f"Post-process LLM correction failed: {e}")
            pass 

    if isinstance(answers, list) and len(answers) > 1:
        answers = [answers[0]]
    
    return answers


# --- Authentication Endpoints ---

@app.route("/register", methods=["POST"])
def register():
    try:
        data = request.json
        username = data.get("username", "").strip()
        email = data.get("email", "").strip()
        password = data.get("password", "").strip()

        if not username or not email or not password:
            return jsonify({"error": "Username, email, and password are required"}), 400

        if len(password) < 6:
            return jsonify({"error": "Password must be at least 6 characters long"}), 400

        # Check if user already exists
        if User.find_by_username(username):
            return jsonify({"error": "Username already exists"}), 409

        if User.find_by_email(email):
            return jsonify({"error": "Email already exists"}), 409

        # Create user
        user_id = User.create_user(username, email, password)
        return jsonify({"message": "User registered successfully", "user_id": user_id}), 201

    except Exception as e:
        print(f"Registration error: {e}")
        return jsonify({"error": "Internal server error"}), 500

@app.route("/login", methods=["POST"])
def login():
    try:
        data = request.json
        email = data.get("email", "").strip()
        password = data.get("password", "").strip()

        if not email or not password:
            return jsonify({"error": "Email and password are required"}), 400

        user = User.find_by_email(email)
        if not user or not User.verify_password(user["password"], password):
            return jsonify({"error": "Invalid credentials"}), 401

        # Update last login
        User.update_last_login(user["username"])

        # Create access token
        access_token = create_access_token(identity=user["username"])
        return jsonify({"access_token": access_token, "username": user["username"]}), 200

    except Exception as e:
        print(f"Login error: {e}")
        return jsonify({"error": "Internal server error"}), 500

@app.route("/history", methods=["GET"])
@jwt_required()
def get_history():
    try:
        username = get_jwt_identity()
        history = History.get_user_history(username)
        return jsonify({"history": history}), 200

    except Exception as e:
        print(f"Get history error: {e}")
        return jsonify({"error": "Internal server error"}), 500

# --- API Endpoint ---
@app.route("/calculate", methods=["POST"])
@jwt_required()
def calculate():
    try:
        data = request.json
        if not data:
            return jsonify({"error": "No JSON data"}), 400

        text = data.get("text", "").strip()
        image_data = data.get("image", "")
        audio_data = data.get("audio", "") 
        dict_of_vars = data.get("dict_of_vars", {})

        final_text_input = text

        # --- 1. Audio Input (Whisper ASR) ---
        if audio_data:
            language = data.get("language", "auto")  # Default to auto-detection
            final_text_input = transcribe_audio_whisper(audio_data, language)
            if not final_text_input:
                return jsonify({"error": "Audio transcription failed. Please check audio format and try again."}), 400

        # --- 2. Image Input (Vision Model for ChatGPT-like analysis) ---
        elif image_data:
            print("Received image data. Processing with vision model...")
            image_question = data.get("image_question", "").strip()
            language = data.get("language", "en")

            # Decode image
            raw_b64 = image_data.split(",")[1] if image_data.startswith("data:image") else image_data

            # Use vision model for analysis
            try:
                message = HumanMessage(
                    content=[
                        {"type": "text", "text": image_question or "Analyze this image and describe what you see."},
                        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{raw_b64}"}}
                    ]
                )
                raw_response = chat.invoke([message])
                vision_result = raw_response.content.strip()

                # For conversational responses, return directly
                if image_question:
                    # Generate TTS for the response
                    tts_audio = generate_tts_audio(vision_result, language or "en")
                    return jsonify({
                        "data": [{
                            "expr": image_question,
                            "result": vision_result,
                            "assign": False,
                            "tts_audio": tts_audio
                        }]
                    })

                # If no question, try OCR for math
                ocr_text, _ = decode_image_and_ocr(image_data)
                has_math_chars = bool(re.search(r'\d|[+\-*/=]', ocr_text))

                # --- MODIFICATION: Refine OCR check to prevent non-math text from entering LLM calculation ---
                if ocr_text and has_math_chars and re.search(r'[+\-*/=]', ocr_text):
                    final_text_input = ocr_text
                    print(f"✅ OCR successfully detected math: '{final_text_input}'")
                else:
                    # OCR failed to find math (or failed entirely), so return the VLM's analysis result
                    tts_audio = generate_tts_audio(vision_result, language or "en")
                    return jsonify({
                        "data": [{
                            "expr": "Image Analysis",
                            "result": vision_result,
                            "assign": False,
                            "tts_audio": tts_audio
                        }]
                    })
                # --- END MODIFICATION ---

            except Exception as e:
                print(f"Vision model error: {e}")
                # Fallback to OCR
                ocr_text, _ = decode_image_and_ocr(image_data)
                has_math_chars = bool(re.search(r'\d|[+\-*/=]', ocr_text))

                if ocr_text and (len(ocr_text) >= 2 or has_math_chars):
                    final_text_input = ocr_text
                    print(f"✅ OCR fallback successful: '{final_text_input}'")
                else:
                    return jsonify({"error": "Image analysis failed. Could not recognize content in the image."}), 400

        # --- 3. Text-only/Final Text Handling (Gemma) ---
        if final_text_input:
            final_text_input = preprocess_text(final_text_input)

            # --- MODIFIED PROMPT START: Incorporating Neuron identity and strict conditional output ---
            prompt_text = (
                f"You are an intelligent educational AI assistant called **Neuron**.\n"
                f"You are trained to analyze images, diagrams, equations, and complex figures in the fields of **mathematics, physics, chemistry, biology, and civic education**.\n"
                f"\n"
                f"🎓 Your tasks include:\n"
                f"1. **Solving simple or complex math, physics, chemistry numericals** from figures, equations, or graphs.\n"
                f"2. **Interpreting chemical structures, physics laws, mechanics, motion, thermodynamics, electromagnetism, etc.**\n"
                f"3. **Recognizing civic awareness topics** (like smoke from factories, improper waste disposal, traffic violations, etc.) and creating **public awareness** with helpful suggestions.\n"
                f"4. **Explaining memes, famous personalities, or cultural references** if detected.\n"
                f"\n"
                f"***CONDITIONAL OUTPUT INSTRUCTION (STRICT)***\n"
                f"**1. SIMPLE PROBLEMS (e.g., 2+2, x=5, 10/2): The 'result' field MUST contain ONLY the direct final numerical value or algebraic solution. NO explanation, NO step-by-step, and NO conversational text is allowed.**\n"
                f"**2. COMPLEX PROBLEMS (e.g., quadratic equations, physics numericals, complex interpretations): The 'result' field MUST contain a full, step-by-step explanation or detailed analysis leading to the solution.**\n"
                f"\n"
                f"Follow these strict instructions for the response:\n"
                f"➤ Return a **list of one or more Python dictionaries**, each with at least these keys: `expr`, `result`, and `assign` (if it's a variable assignment).\n"
                f"➤ Use **double quotes only** for all keys and string values.\n"
                f"➤ Never include backticks or markdown formatting. Your output should be plain, Python-evaluable text.\n"
                f"\n"
                f"📘 Here are examples by category:\n"
                f"1. **Simple Math**: 2 + 2 → `[{{\"expr\": \"2 + 2\", \"result\": 4, \"assign\": false}}]`\n"
                f"2. **Complex Math (Step-by-step)**: Solve x^2 - 4 = 0 → `[{{\"expr\": \"x^2 - 4 = 0\", \"result\": \"This is a difference of squares. (x-2)(x+2)=0. Therefore, the solutions are x=2 and x=-2.\", \"assign\": false}}]`\n"
                f"3. **Variable Assignment**: x = 5, y = 6 → `[{{\"expr\": \"x\", \"result\": 5, \"assign\": true}}, {{\"expr\": \"y\", \"result\": 6, \"assign\": true}}]`\n"
                f"4. **Civic Awareness**: Image showing smoke from an industry → `[{{\"expr\": \"Factory releasing black smoke\", \"result\": \"Air pollution - harmful to health. This violates environmental laws. We must report this to the local EPA and raise public awareness of the health risks.\", \"assign\": false}}]`\n"
                f"5. **Famous Personalities**: Sketch of Einstein → `[{{\"expr\": \"Sketch of Albert Einstein\", \"result\": \"Theory of Relativity. E=mc^2.\", \"assign\": false}}]`\n"
                f"\n"
                f"🧠 Neuron’s special instruction: Always analyze thoroughly. If there's ambiguity, explain your interpretation. Be educational and insightful.\n"
                f"\n"
                f"Variables in current scope: {dict_of_vars}\n"
                f"Input to Analyze: {final_text_input}"
            )
            # --- MODIFIED PROMPT END ---

            try:
                raw_response = llm.invoke(prompt_text)
                raw_response = clean_model_response(raw_response)

                resp_data = json.loads(raw_response)

            except Exception as e:
                print(f"LLM parse failed for input '{final_text_input}': {e}")
                resp_data = [{"expr": final_text_input, "result":f"LLM calculation failed: {str(e)[:50]}...", "assign":False}]

            if isinstance(resp_data, list) and resp_data:
                first_result = resp_data[0]
                first_result["assign"] = first_result.get("assign", False)

                # Generate TTS for the result
                language = data.get("language", "en")
                tts_audio = generate_tts_audio(first_result["result"], language)
                first_result["tts_audio"] = tts_audio

                # Save calculation to history
                username = get_jwt_identity()
                calculation_data = {
                    "type": "text",
                    "input": final_text_input,
                    "result": first_result["result"],
                    "metadata": {"language": data.get("language", "en")}
                }
                History.save_calculation(username, calculation_data)

                return jsonify({"data": [first_result]})
            elif isinstance(resp_data, dict):
                resp_data["assign"] = resp_data.get("assign", False)

                # Generate TTS for the result
                language = data.get("language", "en")
                tts_audio = generate_tts_audio(resp_data["result"], language)
                resp_data["tts_audio"] = tts_audio

                # Save calculation to history
                username = get_jwt_identity()
                calculation_data = {
                    "type": "text",
                    "input": final_text_input,
                    "result": resp_data["result"],
                    "metadata": {"language": data.get("language", "en")}
                }
                History.save_calculation(username, calculation_data)

                return jsonify({"data": [resp_data]})


        return jsonify({"error":"No text or image provided"}), 400

    except Exception as e:
        print("Unexpected fatal error:", e)
        return jsonify({"error": f"Internal server error: {e}"}), 500

# --- Run Server ---
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8900, debug=True)