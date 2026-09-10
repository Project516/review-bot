const URL = "https://openrouter.ai/api/v1/chat/completions";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// complete calls OpenRouter once, retrying on rate limits and upstream
// failures, which the free router hits often. Returns the text and the model
// the router actually picked.
export async function complete({ apiKey, model, messages, attempts = 4 }) {
  let last;
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: 4000 }),
    });
    const body = await res.text();
    if (res.ok) {
      const data = JSON.parse(body);
      const text = data.choices?.[0]?.message?.content;
      if (typeof text === "string" && text.trim()) return { text, model: data.model ?? model };
      last = `empty completion: ${body.slice(0, 300)}`;
    } else if (res.status === 429 || res.status >= 500) {
      last = `${res.status}: ${body.slice(0, 300)}`;
    } else {
      throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 500)}`);
    }
    const wait = 15000 * (i + 1);
    console.log(`openrouter attempt ${i + 1} failed (${last}), retrying in ${wait / 1000}s`);
    await sleep(wait);
  }
  throw new Error(`OpenRouter gave up after ${attempts} attempts: ${last}`);
}
