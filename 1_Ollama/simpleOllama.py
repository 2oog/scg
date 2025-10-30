import ollama

OLLAMA_MODEL = "gemma3:4b"

SYSTEM_PROMPT = "You're helpful assistant. Answer with user's native language."

USER_PROMPT = "Kenapa langit berwarna biru?"

response = ollama.chat(
    model=OLLAMA_MODEL,
    messages=[
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": USER_PROMPT},
    ],
)

print(response["message"]["content"])
