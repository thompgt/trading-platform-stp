import Groq from 'groq-sdk'

let client = null

/** Lazily construct the Groq client so tests can run without GROQ_API_KEY set. */
export function getGroqClient() {
  if (!client) {
    const apiKey = process.env.GROQ_API_KEY
    if (!apiKey) {
      throw new Error('GROQ_API_KEY is not set (see backend/.env.example)')
    }
    client = new Groq({ apiKey })
  }
  return client
}

export function getGroqModel() {
  return process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'
}

/** Reset the cached client — used by tests that inject a fake client. */
export function _setGroqClientForTesting(fakeClient) {
  client = fakeClient
}
