# TODO: Implement Multimodal RAG for PDFs using Ollama Gemma3 and Chroma DB

## Steps to Complete

- [x] Install required dependencies: chromadb, langchain, langchain-community, pypdf2, langchain-ollama
- [x] Modify app.py: Add necessary imports for PDF loading, text splitting, embeddings, and Chroma
- [x] Add PDF loading and processing code on app startup: Load PDFs from textbooks/, extract text, chunk it
- [x] Create vectorstore: Generate embeddings using Ollama (nomic-embed-text), store in Chroma DB
- [x] Add /rag_query endpoint: Implement query handling, similarity search, and response generation with Gemma3
- [ ] Test app startup and PDF loading
- [ ] Test /rag_query endpoint with sample queries
- [ ] (Optional) Implement multimodal image handling: Extract images from PDFs, describe with vision model, integrate into chunks
