import os

from apicostx import ApiClient


def main() -> None:
    with ApiClient(api_key=os.environ["APICOSTX_API_KEY"]) as client:
        presets = client.list_presets(page_size=100)
        items = presets.get("items", [])
        if not items:
            raise SystemExit("No saved presets were found.")

        preset = items[0]
        readiness = client.check_preset(preset["id"])
        if not readiness.get("runnable"):
            raise SystemExit(f"Preset is not runnable: {readiness.get('validation_errors')}")

        started = client.execute_preset(preset["id"])
        print(f"Started run {started['run_id']} from {preset.get('name', preset['id'])}")
        finished = client.wait_for_run(started["run_id"], timeout=1800)
        print(f"Run finished with status: {finished.get('status')}")


if __name__ == "__main__":
    main()
