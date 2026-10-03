// Text → vector through a local Ollama server.
export const EMBED_MODEL = process.env.CONV_MEMORY_EMBED_MODEL ?? "bge-m3";

const host = process.env.OLLAMA_HOST ?? "127.0.0.1:11434";
const OLLAMA_URL = (/^https?:\/\//.test(host) ? host : `http://${host}`).replace(/\/+$/, "");

// Long messages are cut before embedding; the head carries most of what a message is about.
const MAX_CHARS = 2000;

export async function embed(texts: string[], timeoutMs: number): Promise<number[][]> {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: EMBED_MODEL,
      input: texts.map((t) => t.slice(0, MAX_CHARS)),
      keep_alive: "30m", // stay loaded between prompts of a session
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const { embeddings } = (await res.json()) as { embeddings: number[][] };
  return embeddings;
}
