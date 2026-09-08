import os

from apicostx import ApiClient


with ApiClient(api_key=os.environ["APICOSTX_API_KEY"]) as client:
    presets = client.list_presets()
    print(presets)
