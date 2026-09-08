const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const assert = require('node:assert/strict');
const moduleValue = { exports: {} };
const source = ts.transpileModule(fs.readFileSync(__dirname + '/index.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
vm.runInNewContext(source, {
  module: moduleValue, exports: moduleValue.exports, TextDecoder,
  fetch: async () => {
    const text = 'data: {"choices":[{"delta":{"content":"Hello 🦉"}}]}\n\ndata: [DONE]\n\n';
    const bytes = new TextEncoder().encode(text);
    return new Response(new ReadableStream({ start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 3) controller.enqueue(bytes.slice(offset, offset + 3));
      controller.close();
    } }), { headers: { 'content-type': 'text/event-stream' } });
  },
});
(async () => {
  const client = new moduleValue.exports.AllieOwl('fake');
  const iterator = await client.chat.completions.create({ model: 'allie-owl', messages: [], stream: true });
  const chunks = [];
  for await (const chunk of iterator) chunks.push(chunk);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].choices[0].delta.content, 'Hello 🦉');
  console.log('SDK SSE parsing passed with split lines and multibyte characters');
})().catch(error => { console.error(error); process.exitCode = 1; });
