"""
MediMate AI — Structured Security & Audit Logger
Emits JSON log events. Strictly redacts any patient document content,
tokens, passwords, and data encryption keys.
"""

import json
import logging
import sys
from datetime import datetime, timezone
from typing import Any, Dict


class SafeJsonFormatter(logging.Formatter):
    """Formats log records as JSON with sensitive data redaction."""

    SENSITIVE_KEYS = {
        "authorization", "token", "assertion", "secret",
        "api_key", "password", "dek", "content", "extracted_text"
    }

    def format(self, record: logging.LogRecord) -> str:
        payload: Dict[str, Any] = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }

        # Include structured extra fields if present
        if hasattr(record, "structured_data") and isinstance(record.structured_data, dict):
            clean_data = {}
            for k, v in record.structured_data.items():
                if k.lower() in self.SENSITIVE_KEYS:
                    clean_data[k] = "[REDACTED]"
                else:
                    clean_data[k] = v
            payload["context"] = clean_data

        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)

        return json.dumps(payload)


def setup_logging(level: str = "INFO") -> logging.Logger:
    logger = logging.getLogger("medimate_rag")
    logger.setLevel(getattr(logging, level.upper(), logging.INFO))
    logger.handlers.clear()

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(SafeJsonFormatter())
    logger.addHandler(handler)
    logger.propagate = False
    return logger


logger = setup_logging()
