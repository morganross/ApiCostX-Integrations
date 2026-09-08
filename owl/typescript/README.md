# `@apicostx/allie-owl`

TypeScript SDK for the OpenAI-shaped Allie Owl chatbot API.

```ts
import { AllieOwl } from '@apicostx/allie-owl'

const owl = new AllieOwl(process.env.APICOSTX_API_KEY!)
const answer = await owl.chat.completions.create({
  model: 'allie-owl',
  messages: [{ role: 'user', content: 'List my saved presets.' }],
})
console.log(answer.choices[0].message.content)
```

The SDK defaults to `https://assistant.apicostx.com/owl`. Keep the APICostX API
key in a server environment variable; do not use this SDK in browser code.
