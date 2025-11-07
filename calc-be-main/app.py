from flask import Flask, request, jsonify
from flask_cors import CORS
from flask_jwt_extended import JWTManager, jwt_required, create_access_token, get_jwt_identity
import os
import json
import base64
import re
import requests 
from urllib.error import HTTPError 

# --- Import pyttsx3 for local TTS ---
import pyttsx3
from langchain_ollama import OllamaLLM, ChatOllama
from langchain_core.messages import HumanMessage
from dotenv import load_dotenv
# Assuming 'models' module exists and contains User, History
from models import User, History

# === IMPORTS: LCEL RAG CHAIN ===
from langchain_community.vectorstores import FAISS
from langchain_ollama import OllamaEmbeddings
# NOTE: Using 'langchain_classic' for chains as per your previous resolution
from langchain_classic.chains.combine_documents import create_stuff_documents_chain
from langchain_classic.chains.retrieval import create_retrieval_chain
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser

load_dotenv()

# --- Configuration & Initialization ---

# 1. LLM/Ollama Setup
OLLAMA_TEXT_MODEL = os.getenv("OLLAMA_TEXT_MODEL", "qwen2:0.5b")
OLLAMA_VISION_MODEL = os.getenv("OLLAMA_VISION_MODEL", "qwen3-vl:2b")

# 2. RAG Configuration
RAG_EMBEDDING_MODEL = "nomic-embed-text:latest"  # Reusing model from your working code
RAG_FAISS_DIR = "notebook/faiss_db_nomic" # Directory containing your FAISS index (Path Fixed)
# Define the threshold for RAG confidence. If the RAG answer contains this phrase, we fallback to LLM.
RAG_FALLBACK_PHRASE = "not available in the documents" 

app = Flask(__name__)
app.config['JWT_SECRET_KEY'] = os.getenv('JWT_SECRET_KEY', 'your-secret-key-change-in-production')
jwt = JWTManager(app)
CORS(app, resources={r"/*": {"origins": "*"}})

# Initialize base models (Same as before)
try:
    # LLM for General Q/A and RAG answer generation
    llm = ChatOllama(model=OLLAMA_TEXT_MODEL, request_timeout=60) 
    # Vision Model
    chat = ChatOllama(model=OLLAMA_VISION_MODEL)
    print(f"Ollama Models initialized: Text={OLLAMA_TEXT_MODEL}, Vision={OLLAMA_VISION_MODEL}")
except Exception as e:
    print(f"Ollama Model init failed: {e}")
    # Mock implementations for error handling
    llm = lambda x: type("MockResp", (object,), {"content": '{"expr": "LLM not available", "result": "Model initialization failed", "assign": false}'})()
    class MockChat:
        def invoke(self, messages):
            return type("MockResp", (object,), {
                "content": "Image analysis failed. Vision model not available."
            })()
    chat = MockChat()

# TTS Engine Placeholder (pyttsx3)
tts_engine = pyttsx3.init()

# --- RAG Chain Initialization (New Section) ---
try:
    # 1. Load Embeddings and Vector Store
    rag_embeddings = OllamaEmbeddings(model=RAG_EMBEDDING_MODEL)
    rag_vectorstore = FAISS.load_local(
        RAG_FAISS_DIR, 
        rag_embeddings, 
        allow_dangerous_deserialization=True
    )
    rag_retriever = rag_vectorstore.as_retriever(search_kwargs={"k": 3})

    # 2. Define LCEL Prompt
    # NOTE: The system prompt MUST contain a clear instruction for fallback detection.
    rag_template = (
        "You are an accurate, helpful AI assistant. Answer the user's question based ONLY on the context provided below. "
        f"If you cannot find the answer in the context, clearly state that the answer is **{RAG_FALLBACK_PHRASE}**."
        "Context: {context}"
    )
    rag_prompt = ChatPromptTemplate.from_messages(
        [
            ("system", rag_template),
            ("human", "{input}"),
        ]
    )
    
    # 3. Create the LCEL RAG Chain
    rag_document_chain = create_stuff_documents_chain(llm, rag_prompt)
    RAG_QA_CHAIN = create_retrieval_chain(rag_retriever, rag_document_chain)
    print("RAG Chain (LCEL) initialized successfully.")

except Exception as e:
    print(f"RAG Chain initialization FAILED: {e}")
    # Mock chain for error handling
    def mock_rag_chain(input_dict):
        return {'answer': f"RAG service unavailable: {e}. Check FAISS directory and Ollama models.", 'context': []}
    RAG_QA_CHAIN = type("MockRAG", (object,), {"invoke": mock_rag_chain})()


# --- Utility Functions (Kept same) ---
def handle_local_tts(text: str) -> str:
    """ Generates TTS audio locally using pyttsx3 and returns a base64 placeholder. """
    try:
        print(f"ATTENTION: Using local pyttsx3 TTS placeholder for text: '{text[:50]}...'")
        mock_audio_b64 = "UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAABeAAAEABAAFgCgYWN0bAAAAABJTkYGSGZyaWZmAAAARElTVAAAAA=="
        return f"data:audio/wav;base64,{mock_audio_b64}" 

    except Exception as e:
        print(f"LOCAL TTS generation failed: {e}")
        return ""

def preprocess_text(text: str) -> str:
    if not text:
        return ""
    return text

def clean_model_response(raw_response: str) -> str:
    # ... (Keep existing complex JSON cleaning logic) ...
    raw_response = raw_response.strip()

    # 1. Search for explicit JSON tags added in the prompt (REMOVED in new prompt, but kept for robustness)
    tag_match = re.search(r'<JSON_RESPONSE>(.*?)</JSON_RESPONSE>', raw_response, re.DOTALL)
    if tag_match:
        raw_response = tag_match.group(1).strip()
        print("INFO: Extracted content using JSON tags.")

    # 2. Standard markdown cleaning (Handle ```json, ```python, ```, etc.)
    if raw_response.startswith("```json") and raw_response.endswith("```"):
        raw_response = raw_response[7:-3].strip()
        print("INFO: Stripped ```json markdown.")
    elif raw_response.startswith("```python") and raw_response.endswith("```"):
        raw_response = raw_response[9:-3].strip()
        print("INFO: Stripped ```python markdown.")
    elif raw_response.startswith("```") and raw_response.endswith("```"):
        raw_response = raw_response[3:-3].strip()
        print("INFO: Stripped generic markdown.")

    # 3. Standard parsing robustness
    start_match = re.search(r'(\[|\{)', raw_response, re.DOTALL)
    if not start_match:
        print("WARNING: No starting JSON bracket/brace found. Returning empty list string.")
        return "[]"

    start_index = start_match.start()
    trimmed_response = raw_response[start_index:].strip()

    trimmed_response = re.sub(r"'", '"', trimmed_response)
    
    if trimmed_response.startswith('{'):
        # ... (rest of brace counting logic) ...
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
            return '[' + trimmed_response[:end_index] + ']'

    if trimmed_response.startswith('['):
        # ... (rest of bracket counting logic) ...
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
    # ... (Keep the existing implementation) ...
    # Removed for brevity, assumed to be correct based on previous version
    return answers


# --- NEW: General LLM Handler for Fallback (Moved/Refactored Logic) ---
def handle_general_llm_query(query: str, dict_of_vars: dict, language_code: str, username: str):
    """ Handles the text query directly using the general LLM, enforcing JSON output. """
    original_input = query
    llm_input = original_input 
    
    print(f"DEBUG: FALLBACK: Invoking general LLM ({OLLAMA_TEXT_MODEL})...")

    # --- PROMPT: FINAL, STRICT JSON ENFORCEMENT ---
    prompt_text = (
        f"You are Neuron, an intelligent educational AI assistant specializing in **mathematics, physics, chemistry, biology, and civic education**.\n"
        f"Your input may be in a regional language. Analyze the input, process it, and respond in the SAME language if the input is not English.\n\n"
        f"***STRICT OUTPUT ENFORCEMENT***\n"
        f"1. **Your ENTIRE response MUST be ONLY a raw JSON list.** Do not include any explanations, conversational filler, markdown tags (e.g., ```json, ```python, ```), or any text before or after the JSON list.\n"
        f"2. **The JSON structure MUST be a list of dictionaries** with keys: `expr`, `result`, and `assign`.\n\n"
        f"🎓 Tasks and Rules:\n"
        f"- **Simple Numerical/Algebraic Input:** Set 'result' to the **direct numerical value or algebraic solution only**.\n"
        f"- **Complex Problems/Definitions/Civic Issues:** Set 'result' to a **full, step-by-step explanation or clear definition**.\n"
        f"- **News/General Text:** Provide a **brief, relevant explanation of the person or event.**\n\n"
        f"📘 Examples:\n"
        f"  - Math Solution: `[{{\"expr\": \"integration of xdx\", \"result\": \"x^2/2 + C\", \"assign\": false}}]`\n" 
        f"  - Definition (Kannada): `[{{\"expr\": \"ದ್ಯುತಿಸಂಶ್ಲೇಷಣೆ\", \"result\": \"ದ್ಯುತಿಸಂಶ್ಲೇಷಣೆಯು ಸಸ್ಯಗಳು ಸೂರ್ಯನ ಬೆಳಕು, ಕಾರ್ಬನ್ ಡೈಆಕ್ಸೈಡ್ ಮತ್ತು ನೀರನ್ನು ಬಳಸಿ ಗ್ಲೂಕೋಸ್ ಮತ್ತು ಆಮ್ಲಜನಕವನ್ನು ಉತ್ಪಾದಿಸುವ ಪ್ರಕ್ರಿಯೆಯಾಗಿದೆ.\", \"assign\": false}}]`\n"
        f"Variables in Scope: {dict_of_vars}\n\n"
        f"--- BEGIN USER INPUT ---\n"
        f"Input: {llm_input}\n"
        f"--- END USER INPUT ---\n"
    )
    # --- END PROMPT ---

    resp_data = None
    try:
        raw_response = llm.invoke([HumanMessage(content=prompt_text)])
        raw_response = raw_response.content
        
        raw_response = clean_model_response(raw_response)
        resp_data = json.loads(raw_response)
        print("DEBUG: General LLM JSON Parsing SUCCESS.")

    except Exception as e:
        print(f"DEBUG: General LLM FINAL PARSE FAILURE: {e}")
        error_msg = str(e)
        error_result = "Sorry, the AI model encountered a general error."
        if "ReadTimeoutError" in error_msg or "TimeoutError" in error_msg:
            error_result = "The AI model took too long (Timeout: 60s). Please check Ollama server."
        resp_data = [{"expr": original_input, "result": error_result, "assign": False}]
    
    # --- JSON Standardization & History ---
    if isinstance(resp_data, dict):
        resp_data = [resp_data]
    elif not isinstance(resp_data, list):
        resp_data = [{"expr": original_input, "result": str(resp_data), "assign": False}]
    elif not resp_data:
        resp_data = [{"expr": original_input, "result": "Model returned an empty response.", "assign": False}]

    # Ensure required keys exist
    first_result = resp_data[0]
    first_result.setdefault("expr", original_input)
    first_result.setdefault("result", "No result provided")
    first_result.setdefault("assign", False)
    first_result["result"] = str(first_result["result"])
    
    tts_audio = handle_local_tts(first_result["result"])
    first_result["tts_audio"] = tts_audio
    
    History.save_calculation(username, {
        "type": "text_general",
        "input": original_input,
        "result": first_result["result"],
        "metadata": {"language_code": language_code}
    })
    return resp_data


# --- NEW: RAG Handler (Moved/Refactored Logic) ---
def handle_rag_query(query: str, language_code: str, username: str):
    """ Handles queries against the FAISS vector store using the LCEL RAG chain. """
    print(f"DEBUG: Initiating RAG query for user '{username}' with input: '{query[:50]}...'")

    try:
        # Invoke the pre-initialized RAG Chain
        rag_result = RAG_QA_CHAIN.invoke({"input": query})

        final_answer = rag_result.get('answer', f'RAG chain failed to return an answer. {RAG_FALLBACK_PHRASE}')
        source_documents = rag_result.get('context', [])
        
        # Check for RAG fallback phrase to signal low confidence
        if RAG_FALLBACK_PHRASE.lower() in final_answer.lower():
            print("DEBUG: RAG returned low-confidence answer (no documents found). Triggering LLM fallback.")
            return None, None, None # Signal fallback
            
        # Extract metadata for sources
        sources = set([doc.metadata.get('source', 'N/A') for doc in source_documents])
        source_info = list(sources)
        
        # Prepare response data
        tts_audio = handle_local_tts(final_answer)
        resp_data = [{
            "expr": query,
            "result": final_answer,
            "assign": False,
            "tts_audio": tts_audio,
            "sources": source_info
        }]
        
        History.save_calculation(username, {
            "type": "rag",
            "input": query,
            "result": final_answer,
            "metadata": {"language_code": language_code, "sources": source_info}
        })
        print("DEBUG: RAG query complete. Returning result.")
        return resp_data, 200, None

    except Exception as e:
        print(f"DEBUG: RAG chain failed: {e}. Falling back to general LLM.")
        return None, None, e # Signal fallback

# --- Authentication/History Endpoints (Kept same) ---
@app.route("/", methods=["GET"])
def root():
    return jsonify({"message": "Neuron Backend API", "status": "running"}), 200

# ... (register, login, get_history endpoints are unchanged and omitted for brevity) ...

# --- Authentication/History Endpoints (Same as before) ---
@app.route("/register", methods=["POST"])
def register():
    # ... (Keep the existing implementation) ...
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
    # ... (Keep the existing implementation) ...
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
    # ... (Keep the existing implementation) ...
    try:
        username = get_jwt_identity()         
        history = History.get_user_history(username)
        return jsonify({"history": history}), 200

    except Exception as e:
        print(f"Get history error: {e}")
        return jsonify({"error": "Internal server error"}), 500

# --- NEW: RAG Query Endpoint (Now only uses RAG handler) ---
@app.route("/rag_query", methods=["POST"])
@jwt_required()
def rag_query_endpoint():
    """ Public endpoint for RAG queries. Does NOT contain the LLM fallback. """
    try:
        data = request.json
        query = data.get("query", "").strip()
        language_code = data.get("language_code", "en-US")
        username = get_jwt_identity()

        if not query:
             return jsonify({"error": "Query text is required for RAG analysis."}), 400

        resp_data, status, error = handle_rag_query(query, language_code, username)

        if error or resp_data is None:
             # This specific endpoint is designed for RAG, so an error/no-match returns a failure message
             return jsonify({"error": "RAG query failed or found no relevant documents."}), 500
        
        return jsonify({"data": resp_data}), 200

    except Exception as e:
        print(f"DEBUG: Unexpected fatal error in rag_query_endpoint: {e}")
        return jsonify({"error": f"Internal server error: {e}"}), 500


# --- API Endpoint (calculate - NOW THE ROUTING ENDPOINT) ---
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
        language_code = data.get("language_code", "en-US") 
        username = get_jwt_identity() # Get username early

        # --- 1. Audio Input (DISABLED) ---
        if audio_data:
            print("DEBUG: Audio input received but ASR is disabled.")
            return jsonify({"error": "Audio input (ASR) is currently disabled due to external service instability."}), 500
        
        # --- 2. Image Input (Vision Model) ---
        elif image_data:
            # ... (VLM logic remains the same) ...
            print("DEBUG: Image data received. Initiating VLM processing for direct response.")
            raw_b64 = image_data.split(",")[1] if image_data.startswith("data:image") else image_data
            
            # --- VLM-SPECIFIC PROMPT (STRICT RAW JSON) ---
            vlm_prompt_text = (
            f"You are Neuron, an expert VLM assistant. Analyze the image for problems or content.\n"
    f"***TASK: Extract the core content or analyze the image and generate a brief explanation/solution.***\n\n"
    f"1. **Your ENTIRE response MUST be ONLY a raw JSON list.** Do not include any explanations, conversational filler, markdown tags (e.g., ```json, ```python, ```), or any text before or after the JSON list.\n"
    f"2. **The JSON structure MUST be a list of dictionaries** with keys: `expr`, `result`, and `assign`.\n"
    f"3. **Format:** `[{{\"expr\": \"Image Summary/Problem\", \"result\": \"Detailed Answer/Explanation\", \"assign\": false/true}}]`\n\n"
    f"Variables: {dict_of_vars}\n"
            )
            # --- END VLM-SPECIFIC PROMPT ---
            
            vlm_resp_data = None
            try:
                message = HumanMessage(
                    content=[
                        {"type": "text", "text": vlm_prompt_text},
                        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{raw_b64}"}}
                    ]
                )
                raw_response = chat.invoke([message])
                raw_response_content = clean_model_response(raw_response.content)
                vlm_resp_data = json.loads(raw_response_content)
                print("DEBUG: VLM JSON Parsing SUCCESS.")

            except Exception as e:
                print(f"DEBUG: VLM FINAL PARSE FAILURE: {e}")
                vlm_resp_data = [{"expr": "Image Analysis Failed", "result": "VLM could not generate valid JSON. Please try again.", "assign": False}]
            
            if isinstance(vlm_resp_data, dict): vlm_resp_data = [vlm_resp_data]
            elif not isinstance(vlm_resp_data, list) or not vlm_resp_data:
                vlm_resp_data = [{"expr": "Image Analysis Failed", "result": "VLM returned unprocessable data.", "assign": False}]

            first_result = vlm_resp_data[0]
            first_result["result"] = str(first_result.get("result", ""))
            
            tts_audio = handle_local_tts(first_result["result"])
            first_result["tts_audio"] = tts_audio
            
            History.save_calculation(username, {
                "type": "image",
                "input": first_result.get("expr", "Image Analysis"),
                "result": first_result["result"],
                "metadata": {"language_code": language_code}
            })
            print("DEBUG: Image analysis complete. Returning VLM JSON response.")
            return jsonify({"data": vlm_resp_data})


        # --- 3. Text-only Handling: RAG-First Routing ---
        if text:
            
            # --- Attempt 1: RAG Query ---
            rag_data, status, error = handle_rag_query(text, language_code, username)
            
            if rag_data is not None:
                # RAG was successful (found documents and returned a confident answer)
                print("DEBUG: RAG success. Returning RAG result.")
                return jsonify({"data": rag_data}), status
            
            # If rag_data is None, it means the RAG chain signaled a fallback (no documents found)
            print("DEBUG: RAG failed to find documents or returned error. Falling back to general LLM.")
            
            # --- Attempt 2: General LLM Fallback ---
            llm_data = handle_general_llm_query(text, dict_of_vars, language_code, username)
            print("DEBUG: LLM Fallback complete. Returning LLM result.")
            return jsonify({"data": llm_data}), 200

        # No valid input
        print("DEBUG: No valid text, image, or audio input found.")
        return jsonify({"error":"No valid text, audio, or image input provided for analysis."}), 400

    except Exception as e:
        print(f"DEBUG: Unexpected fatal error in calculate endpoint: {e}")
        return jsonify({"error": f"Internal server error: {e}"}), 500


# --- Run Server ---
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8900, debug=True)