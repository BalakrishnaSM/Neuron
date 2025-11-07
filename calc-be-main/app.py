import os
import json
import re
from typing import Optional
from dotenv import load_dotenv
import logging
import base64

from flask import Flask, request, jsonify
from flask_cors import CORS
from flask_jwt_extended import JWTManager, jwt_required, create_access_token, get_jwt_identity

# === NEW: Import deep-translator for stable translation ===
try:
    from deep_translator import GoogleTranslator
except ImportError:
    print("WARNING: 'deep-translator' not found. Please run 'pip install deep-translator'. Translation will be disabled.")
    GoogleTranslator = None
# =========================================================

# === LANGCHAIN IMPORTS ===
from langchain_ollama import OllamaLLM, ChatOllama, OllamaEmbeddings
from langchain_core.messages import HumanMessage
from langchain_community.vectorstores import FAISS
# NOTE: Using 'langchain_classic' for older chain functions
from langchain_classic.chains.combine_documents import create_stuff_documents_chain
from langchain_classic.chains.retrieval import create_retrieval_chain
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser

# Assuming 'models' module exists and contains User, History
# NOTE: Ensure models.py is present and functional
from models import User, History 

load_dotenv()

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# --- Configuration & Initialization ---

# 1. LLM/Ollama Setup
OLLAMA_TEXT_MODEL = os.getenv("OLLAMA_TEXT_MODEL", "qwen2:0.5b")
OLLAMA_VISION_MODEL = os.getenv("OLLAMA_VISION_MODEL", "qwen3-vl:2b")

# 2. RAG Configuration
RAG_EMBEDDING_MODEL = os.getenv("RAG_EMBEDDING_MODEL", "nomic-embed-text:latest")
RAG_FAISS_DIR = "notebook/faiss_db_nomic" 
RAG_FALLBACK_PHRASE = "not available in the documents" 

app = Flask(__name__)
app.config['JWT_SECRET_KEY'] = os.getenv('JWT_SECRET_KEY', 'your-secret-key-change-in-production')
jwt = JWTManager(app)
CORS(app, resources={r"/*": {"origins": "*"}})

# Initialize base models
try:
    llm = ChatOllama(model=OLLAMA_TEXT_MODEL, request_timeout=60) 
    chat = ChatOllama(model=OLLAMA_VISION_MODEL)
    logging.info(f"Ollama Models initialized: Text={OLLAMA_TEXT_MODEL}, Vision={OLLAMA_VISION_MODEL}")
except Exception as e:
    logging.error(f"Ollama Model init failed: {e}")
    # Mock implementations for error handling
    llm = lambda x: type("MockResp", (object,), {"content": '[{"expr": "LLM not available", "result": "Model initialization failed", "assign": false}]'})()
    class MockChat:
        def invoke(self, messages):
            return type("MockResp", (object,), {"content": '[{"expr": "Image analysis failed", "result": "Vision model not available.", "assign": false}]'})()
    chat = MockChat()

# --- RAG Chain Initialization ---
try:
    rag_embeddings = OllamaEmbeddings(model=RAG_EMBEDDING_MODEL)
    rag_vectorstore = FAISS.load_local(
        RAG_FAISS_DIR, 
        rag_embeddings, 
        allow_dangerous_deserialization=True
    )
    rag_retriever = rag_vectorstore.as_retriever(search_kwargs={"k": 3})

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
    
    rag_document_chain = create_stuff_documents_chain(llm, rag_prompt)
    RAG_QA_CHAIN = create_retrieval_chain(rag_retriever, rag_document_chain)
    logging.info("RAG Chain (LCEL) initialized successfully.")

except Exception as e:
    logging.error(f"RAG Chain initialization FAILED: {e}")
    # Mock chain for error handling
    def mock_rag_chain(input_dict):
        return {'answer': f"RAG service unavailable: {e}. Check FAISS directory and Ollama models. {RAG_FALLBACK_PHRASE}", 'context': []}
    RAG_QA_CHAIN = type("MockRAG", (object,), {"invoke": mock_rag_chain})()


# === Global Translator Client Initialization (using deep-translator) ===
translator = GoogleTranslator(source='auto', target='en') if GoogleTranslator else None
if translator:
    logging.info("Deep-Translator initialized for source-to-English translation.")
# =====================================================================

# --- Utility Functions (Cleaned for brevity, assuming existing functionality) ---

def preprocess_text(text: str) -> str:
    return text.strip() if text else ""

def clean_model_response(raw_response: str) -> str:
    # NOTE: This complex logic is crucial for robust LLM JSON parsing
    raw_response = raw_response.strip()

    # 1. Standard markdown cleaning (Handle ```json, ```python, ```, etc.)
    if raw_response.startswith("```"):
        raw_response = re.sub(r'^(```json|```python|```)\s*', '', raw_response, flags=re.IGNORECASE)
        raw_response = re.sub(r'\s*```$', '', raw_response)
        logging.info("Stripped markdown tags.")

    # 2. Find and trim to the primary JSON structure ({...} or [...])
    start_match = re.search(r'(\[|\{)', raw_response, re.DOTALL)
    if not start_match:
        logging.warning("No starting JSON bracket/brace found. Returning empty list string.")
        return "[]"

    start_index = start_match.start()
    trimmed_response = raw_response[start_index:].strip()
    
    # 3. Handle single object vs. list of objects
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

    return "[]"

# --- NEW TRANSLATION UTILITY FUNCTIONS (using deep-translator) ---

def safe_translate(text: str, dest_lang: str) -> str:
    """Translates text using deep-translator, handling potential errors."""
    if not GoogleTranslator:
        return text 
        
    # Convert 'en-US' or 'kn-IN' format to standard 'en' or 'kn'
    dest_lang_simple = dest_lang.split('-')[0].lower()
    
    if not text.strip():
        return ""

    try:
        if dest_lang_simple == 'en':
            # Use the global 'translator' object (source='auto', target='en')
            result = translator.translate(text)
        else:
            # Create a temporary translator instance for the specific target language
            # This handles the reverse translation (English -> Target Language)
            temp_translator = GoogleTranslator(source='auto', target=dest_lang_simple)
            result = temp_translator.translate(text)
            
        if result:
            return result
        
        logging.warning(f"Translation failed for '{text[:20]}...' to {dest_lang_simple}. Returning original.")
        return text

    except Exception as e:
        logging.error(f"Translation error: {e}. Returning original text.", exc_info=True)
        return text


# --- General LLM Handler ---
def handle_general_llm_query(query: str, dict_of_vars: dict, original_lang_code: str, username: str):
    """ Handles the text query directly using the general LLM. Query input is expected to be in ENGLISH."""
    original_input = query 
    llm_input = original_input 
    
    logging.debug(f"FALLBACK: Invoking general LLM ({OLLAMA_TEXT_MODEL})...")

    # --- PROMPT: Enforce English response to be translated later ---
    prompt_text = (
        f"You are Neuron, an intelligent educational AI assistant specializing in **mathematics, physics, chemistry, biology, and civic education**.\n"
        f"The user input has been translated into English for you. **Your response MUST be in English.**\n\n"
        f"***STRICT OUTPUT ENFORCEMENT***\n"
        f"1. **Your ENTIRE response MUST be ONLY a raw JSON list.** Do not include any explanations, conversational filler, markdown tags (e.g., ```json, ```python, ```), or any text before or after the JSON list.\n"
        f"2. **The JSON structure MUST be a list of dictionaries** with keys: `expr`, `result`, and `assign`.\n\n"
        f"Variables in Scope: {dict_of_vars}\n\n"
        f"--- BEGIN USER INPUT (English) ---\n"
        f"Input: {llm_input}\n"
        f"--- END USER INPUT ---\n"
    )

    resp_data = None
    try:
        raw_response = llm.invoke([HumanMessage(content=prompt_text)])
        raw_response = raw_response.content
        
        raw_response = clean_model_response(raw_response)
        resp_data = json.loads(raw_response)
        logging.debug("General LLM JSON Parsing SUCCESS.")

    except Exception as e:
        logging.error(f"General LLM FINAL PARSE FAILURE: {e}")
        error_result = "Sorry, the AI model encountered an error or timed out."
        resp_data = [{"expr": original_input, "result": error_result, "assign": False}]
    
    # --- JSON Standardization & History ---
    if not isinstance(resp_data, list):
           resp_data = [{"expr": original_input, "result": str(resp_data), "assign": False}]
    
    # Ensure required keys exist in the first item
    if resp_data and isinstance(resp_data[0], dict):
        first_result = resp_data[0]
        first_result.setdefault("expr", original_input)
        first_result.setdefault("result", "No result provided")
        first_result.setdefault("assign", False)
        first_result["result"] = str(first_result["result"])

        History.save_calculation(username, {
            "type": "text_general",
            "input": original_input,
            "result": first_result["result"],
            "metadata": {"language_code": original_lang_code}
        })
    return resp_data # Returns JSON data where 'result' is in English


# --- RAG Handler ---
def handle_rag_query(query: str, original_lang_code: str, username: str):
    """ Handles queries against the FAISS vector store. Query input is expected to be in ENGLISH."""
    logging.debug(f"Initiating RAG query for user '{username}' with input (English): '{query[:50]}...'")

    try:
        rag_result = RAG_QA_CHAIN.invoke({"input": query})

        final_answer = rag_result.get('answer', f'RAG chain failed to return an answer. {RAG_FALLBACK_PHRASE}')
        source_documents = rag_result.get('context', [])
        
        # Check for RAG fallback phrase to signal low confidence
        if RAG_FALLBACK_PHRASE.lower() in final_answer.lower():
            logging.debug("RAG returned low-confidence answer (no documents found). Triggering LLM fallback.")
            return None, None, None # Signal fallback
            
        # Prepare response data (final_answer is in ENGLISH)
        resp_data = [{
            "expr": query,
            "result": final_answer,
            "assign": False,
            "sources": list(set([doc.metadata.get('source', 'N/A') for doc in source_documents]))
        }]
        
        History.save_calculation(username, {
            "type": "rag",
            "input": query,
            "result": final_answer,
            "metadata": {"language_code": original_lang_code, "sources": resp_data[0]['sources']}
        })
        logging.debug("RAG query complete. Returning result.")
        return resp_data, 200, None

    except Exception as e:
        logging.error(f"RAG chain failed: {e}. Falling back to general LLM.", exc_info=True)
        return None, None, e # Signal fallback

# --- Authentication/History Endpoints (Unchanged) ---
@app.route("/", methods=["GET"])
def root():
    return jsonify({"message": "Neuron Backend API", "status": "running"}), 200

@app.route("/register", methods=["POST"])
def register():
    # ... (Implementation omitted for brevity) ...
    try:
        data = request.json
        username = data.get("username", "").strip()
        email = data.get("email", "").strip()
        password = data.get("password", "").strip()

        if not username or not email or not password:
            return jsonify({"error": "Username, email, and password are required"}), 400
        if len(password) < 6:
            return jsonify({"error": "Password must be at least 6 characters long"}), 400
        if User.find_by_username(username) or User.find_by_email(email):
             return jsonify({"error": "Username or email already exists"}), 409

        user_id = User.create_user(username, email, password)
        return jsonify({"message": "User registered successfully", "user_id": user_id}), 201

    except Exception as e:
        logging.error(f"Registration error: {e}")
        return jsonify({"error": "Internal server error"}), 500

@app.route("/login", methods=["POST"])
def login():
    # ... (Implementation omitted for brevity) ...
    try:
        data = request.json
        email = data.get("email", "").strip()
        password = data.get("password", "").strip()

        if not email or not password:
            return jsonify({"error": "Email and password are required"}), 400

        user = User.find_by_email(email)
        if not user or not User.verify_password(user["password"], password):
            return jsonify({"error": "Invalid credentials"}), 401

        User.update_last_login(user["username"])
        access_token = create_access_token(identity=user["username"])
        return jsonify({"access_token": access_token, "username": user["username"]}), 200

    except Exception as e:
        logging.error(f"Login error: {e}")
        return jsonify({"error": "Internal server error"}), 500

@app.route("/history", methods=["GET"])
@jwt_required()
def get_history():
    # ... (Implementation omitted for brevity) ...
    try:
        username = get_jwt_identity() 
        history = History.get_user_history(username)
        return jsonify({"history": history}), 200

    except Exception as e:
        logging.error(f"Get history error: {e}")
        return jsonify({"error": "Internal server error"}), 500

@app.route("/rag_query", methods=["POST"])
@jwt_required()
def rag_query_endpoint():
    # ... (Implementation omitted for brevity) ...
    try:
        data = request.json
        query = data.get("query", "").strip()
        language_code = data.get("language_code", "en-US")
        username = get_jwt_identity()

        if not query:
             return jsonify({"error": "Query text is required for RAG analysis."}), 400

        # NOTE: This endpoint assumes the input 'query' is already in ENGLISH 
        resp_data, status, error = handle_rag_query(query, language_code, username)

        if error or resp_data is None:
             return jsonify({"error": "RAG query failed or found no relevant documents."}), 500
        
        # No reverse translation needed here as this is a specific, separate RAG endpoint
        return jsonify({"data": resp_data}), 200

    except Exception as e:
        logging.error(f"Unexpected fatal error in rag_query_endpoint: {e}")
        return jsonify({"error": f"Internal server error: {e}"}), 500


# --- API Endpoint (calculate) ---
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
        language_code = data.get("language_code", "en-US") # User's target language
        username = get_jwt_identity() 
        target_lang = language_code.split('-')[0].lower() # e.g., 'kn-IN' -> 'kn'
        
        # --- 1. Audio Input (DISABLED) ---
        if audio_data:
            logging.warning("Audio input (ASR) is currently disabled.")
            return jsonify({"error": "Audio input (ASR) is currently disabled."}), 500
        
        # --- 2. Image Input (Vision Model) ---
        elif image_data:
            logging.info("Image data received. Initiating VLM processing.")
            raw_b64 = image_data.split(",")[1] if image_data.startswith("data:image") else image_data
            
            # --- VLM-SPECIFIC PROMPT (STRICT RAW JSON) ---
            vlm_prompt_text = (
                f"You are Neuron, an expert VLM assistant. Analyze the image and generate a brief explanation/solution in **English**.\n"
                f"***STRICT OUTPUT ENFORCEMENT***\n"
                f"1. **Your ENTIRE response MUST be ONLY a raw JSON list** with keys: `expr`, `result`, and `assign`.\n"
                f"2. **Format:** `[{{\"expr\": \"Image Summary/Problem\", \"result\": \"Detailed Answer/Explanation\", \"assign\": false/true}}]`\n"
                f"Variables: {dict_of_vars}\n"
            )
            
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
                logging.debug("VLM JSON Parsing SUCCESS.")

            except Exception as e:
                logging.error(f"VLM FINAL PARSE FAILURE: {e}")
                vlm_resp_data = [{"expr": "Image Analysis Failed", "result": "VLM could not generate valid JSON.", "assign": False}]
            
            if not isinstance(vlm_resp_data, list) or not vlm_resp_data:
                vlm_resp_data = [{"expr": "Image Analysis Failed", "result": "VLM returned unprocessable data.", "assign": False}]

            # VLM Output: Translate back to user's language (if needed)
            if target_lang != 'en':
                logging.info(f"Translating VLM output from 'en' back to {target_lang}...")
                for item in vlm_resp_data:
                    english_result = item.get("result", "")
                    if english_result.strip():
                        item['result'] = safe_translate(english_result, target_lang)

            # History saving for VLM remains the same
            first_result = vlm_resp_data[0]
            first_result["result"] = str(first_result.get("result", ""))
            History.save_calculation(username, {
                "type": "image",
                "input": first_result.get("expr", "Image Analysis"),
                "result": first_result["result"],
                "metadata": {"language_code": language_code}
            })
            return jsonify({"data": vlm_resp_data})


        # --- 3. Text-only Handling: RAG-First Routing with Translation ---
        if text:
            
            # 3a. Translate User Input (Source Language -> English)
            text_english = text
            if target_lang != 'en':
                logging.info(f"Translating input from {target_lang} to 'en'...")
                text_english = safe_translate(text, 'en')
                if text_english == text:
                    logging.warning("Input translation failed or returned original text.")

            # --- Attempt 1: RAG Query (Uses English input) ---
            rag_data, status, error = handle_rag_query(text_english, language_code, username)
            
            if rag_data is not None:
                # RAG was successful (The result is in ENGLISH)
                llm_data = rag_data
                logging.debug("RAG success. Continuing to reverse translation.")
            else:
                # RAG failed (No confident answer)
                logging.debug("RAG failed or signaled fallback. Falling back to general LLM.")
                # --- Attempt 2: General LLM Fallback (Uses English input) ---
                llm_data = handle_general_llm_query(text_english, dict_of_vars, language_code, username)
                logging.debug("LLM Fallback complete. Continuing to reverse translation.")

            # --- 4. Translate Model Output (English -> Target Language) ---
            
            final_data = llm_data

            if target_lang != 'en':
                logging.info(f"Translating model output from 'en' back to {target_lang}...")
                for item in final_data:
                    english_result = item.get("result", "")
                    
                    # Prevent translating empty or error messages
                    if english_result.strip() and not ("error" in english_result.lower() or "not available" in english_result.lower()):
                        translated_result = safe_translate(english_result, target_lang)
                        item['result'] = translated_result
            
            logging.debug("Final response ready. Returning JSON.")
            return jsonify({"data": final_data}), 200

        # No valid input
        logging.warning("No valid text or image input found.")
        return jsonify({"error":"No valid text or image input provided for analysis."}), 400

    except Exception as e:
        logging.critical(f"Unexpected fatal error in calculate endpoint: {e}", exc_info=True)
        return jsonify({"error": f"Internal server error: {e}"}), 500


# --- Run Server ---
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8900, debug=True)