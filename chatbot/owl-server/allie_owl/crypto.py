from __future__ import annotations

import base64
import json
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


class FieldCipher:
    def __init__(self, key: bytes):
        self.key = key

    def encrypt(self, value: str, aad: str) -> str:
        nonce = os.urandom(12)
        ciphertext = AESGCM(self.key).encrypt(nonce, value.encode(), aad.encode())
        return "acxowl:v1:" + base64.urlsafe_b64encode(nonce + ciphertext).decode()

    def decrypt(self, value: str, aad: str) -> str:
        if not value.startswith("acxowl:v1:"):
            raise ValueError("Invalid encrypted Owl field")
        payload = base64.urlsafe_b64decode(value[10:].encode())
        return AESGCM(self.key).decrypt(payload[:12], payload[12:], aad.encode()).decode()

    def encrypt_json(self, value: object, aad: str) -> str:
        return self.encrypt(json.dumps(value, separators=(",", ":"), sort_keys=True), aad)

    def decrypt_json(self, value: str, aad: str) -> object:
        return json.loads(self.decrypt(value, aad))

