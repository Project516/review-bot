const URL = "https://openrouter.ai/api/v1/chat/completions";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const NUDGE = {
  role: "system",
  content:
    "Your last reply was discarded: it was not the required JSON object. Some of what you sent was working notes, or a moderation verdict, or it stopped before the object was finished. Send the single JSON object only, starting with { and ending with }, and keep the summary short.",
};

// complete calls OpenRouter until accept() turns the reply into something
// usable, retrying on rate limits, upstream failures, truncated answers, and
// replies that are not a review at all. Attempt i goes to models[i], wrapping
// around, so a retry is also how we get off a model that is down, gone from
// the free list, or thinking out loud.
export async function complete({ apiKey, models, messages, accept = (t) => t, attempts = 5, backoff = 15000, log = console.log }) {
  let last = "no attempt made";
  let nudge = false;
  for (let i = 0; i < attempts; i++) {
    if (i) {
      const wait = backoff * i;
      log(`openrouter attempt ${i} failed (${last}), retrying in ${wait / 1000}s`);
      await sleep(wait);
    }
    const model = models[i % models.length];
    const res = await fetch(URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: nudge ? [...messages, NUDGE] : messages,
        temperature: 0.2,
        max_tokens: 8000,
        // Keep a reasoning model's trace out of the content we publish.
        reasoning: { exclude: true },
      }),
    });
    const body = await res.text();
    if (!res.ok) {
      // 400 and 404 are what a model that left the free list or cannot take
      // this prompt answers; the next model may not. Auth and credit errors
      // would fail the same way on every model.
      if (![400, 404, 429].includes(res.status) && res.status < 500) throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 500)}`);
      last = `${model} ${res.status}: ${body.slice(0, 300)}`;
      continue;
    }
    const data = JSON.parse(body);
    const choice = data.choices?.[0];
    const text = choice?.message?.content;
    const picked = data.model ?? model;
    if (typeof text !== "string" || !text.trim()) {
      last = `${picked} returned an empty completion`;
      continue;
    }
    if (choice.finish_reason === "length") {
      last = `${picked} ran out of tokens before finishing`;
      nudge = true;
      continue;
    }
    const value = accept(text);
    if (value != null) return { value, text, model: picked };
    last = `${picked} did not reply with a review (${text.length} chars)`;
    nudge = true;
  }
  throw new Error(`OpenRouter gave up after ${attempts} attempts: ${last}`);
}
