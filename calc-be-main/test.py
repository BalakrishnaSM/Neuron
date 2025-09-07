from langchain_core.prompts import ChatPromptTemplate
from langchain_ollama.llms import OllamaLLM

template = """Question: {question}

Answer: Please give a concise final answer and a short explanation (no internal chain-of-thought)."""

prompt = ChatPromptTemplate.from_template(template)

# IMPORTANT: use the exact model id listed by `ollama ls`, e.g. "gemma:2b", "gemma:3b", "gemma3" etc.
model = OllamaLLM(model="gemma3")

# build the chain
chain = prompt | model

# invoke
output = chain.invoke({"question": "What is LangChain?"})

# inspect & print safely
print(">>> returned type:", type(output))
# common cases:
if isinstance(output, str):
    print(output)
elif isinstance(output, dict):
    # many LLM wrappers return dict-like objects; try common keys
    print(output.get("text") or output.get("response") or output)
elif hasattr(output, "generations"):
    # LLMResult-like object (LangChain): print first generation
    try:
        print(output.generations[0][0].text)
    except Exception:
        print(repr(output))
else:
    print(repr(output))
