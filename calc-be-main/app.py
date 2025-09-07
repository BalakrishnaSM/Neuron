from flask import Flask, request, jsonify
from flask_cors import CORS
import os
import json
import base64
from PIL import Image
import easyocr
import numpy as np
import io

# LangChain + Ollama
from langchain_ollama.llms import OllamaLLM

# --- Configuration ---
# Pick the correct model id from `ollama ls` (e.g. "gemma:2b", "gemma:7b", "gemma2")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "gemma3")

# Initialize Flask app
app = Flask(__name__)
CORS(app, resources={r"/calculate": {"origins": "*"}})

# Initialize Ollama LLM via LangChain
llm = OllamaLLM(model=OLLAMA_MODEL)

# Initialize EasyOCR reader
reader = easyocr.Reader(['en'])

# --- API Endpoints ---
@app.route("/calculate", methods=["POST"])
def calculate():
    """
    Receives OCR text from the frontend,
    sends it to Gemma for math solving,
    and returns structured JSON.
    """
    try:
        data = request.json
        if not data:
            return jsonify({"error": "No JSON data provided"}), 400

        text = data.get("text", "")
        dict_of_vars = data.get("dict_of_vars", {})

        if not text:
            # Check for image
            image_data = data.get("image", "")
            if image_data:
                if image_data.startswith('data:image/png;base64,'):
                    image_data = image_data.split(',')[1]
                image = Image.open(io.BytesIO(base64.b64decode(image_data)))
                # Optimize image for OCR
                image = image.convert('L')  # Convert to grayscale
                # Invert for white text on black background
                image = Image.eval(image, lambda x: 255 - x)
                # Resize to improve OCR accuracy
                image = image.resize((800, 600), Image.Resampling.LANCZOS)
                image_np = np.array(image)
                ocr_result = reader.readtext(image_np, detail=1)
                text = ' '.join([res[1] for res in ocr_result])
                if not text.strip():
                    text = "No text recognized in the image. Please draw a math equation or type it in the text box."
            else:
                return jsonify({"error": "No text or image provided"}), 400

        # Add spaces between numbers and operators for better parsing
        if text and text != "No text recognized in the image. Please draw a math equation or type it in the text box.":
            import re
            text = re.sub(r'(\d)([a-zA-Z])', r'\1 \2', text)
            text = re.sub(r'([a-zA-Z])(\d)', r'\1 \2', text)
            text = re.sub(r'(\d)([+\-*/=])', r'\1 \2', text)
            text = re.sub(r'([+\-*/=])(\d)', r'\1 \2', text)
            text = re.sub(r'([a-zA-Z])([+\-*/=])', r'\1 \2', text)
            text = re.sub(r'([+\-*/=])([a-zA-Z])', r'\1 \2', text)

        # Build math-specific prompt
        vars_str = ", ".join([f"{k}={v}" for k, v in dict_of_vars.items()]) if dict_of_vars else ""
        prompt_text = (
            "You are an intelligent educational AI assistant called **Neuron**.\n"
            "Always keep answers short and concise.\n"
            "You are trained to analyze images, diagrams, equations, and complex figures in the fields of **mathematics, physics, chemistry, biology, and civic education**.\n"
            "\n"
            "🎓 Your tasks include:\n"
            "1. **Solving simple or complex math, physics, chemistry numericals** from figures, equations, or graphs.\n"
            "2. **Interpreting chemical structures, physics laws, mechanics, motion, thermodynamics, electromagnetism, etc.**\n"
            "3. **Recognizing civic awareness topics** (like smoke from factories, improper waste disposal, traffic violations, etc.) and creating **public awareness** with helpful suggestions.\n"
            "4. **Explaining memes, famous personalities, or cultural references** if detected.\n"
            "\n"
            "If the input is a math problem, solve it step by step and provide the final answer clearly. Known variables: {vars_str}.\n"
            "If the input is not a math problem, respond directly and simply without any formatting or extra text.\n"
            "Input: {text}"
        ).format(vars_str=vars_str, text=text)

        # Call Gemma
        raw_response = llm.invoke(prompt_text)

        # Return structured response
        return jsonify({
            "data": [{
                "expr": text,
                "result": raw_response,
                "assign": False
            }]
        })

    except Exception as e:
        print(f"An unexpected error occurred: {e}")
        return jsonify({"error": "An internal server error occurred"}), 500


# --- Server Startup ---
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8900, debug=True)
