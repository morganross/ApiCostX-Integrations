import os

from allie_owl_client import AllieOwl


client = AllieOwl(os.environ["APICOSTX_API_KEY"])
answer = client.chat.completions.create(
    model="allie-owl",
    messages=[{"role": "user", "content": "List my saved presets."}],
    store=True,
)
print(answer["choices"][0]["message"]["content"])
