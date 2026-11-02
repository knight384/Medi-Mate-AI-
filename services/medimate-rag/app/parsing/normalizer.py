"""
MediMate AI — Clinical Text Normalizer & Section Detector
Cleans extracted text, standardizes whitespace, and extracts section headings.
"""

import re
from typing import List, Tuple


# Common clinical section patterns
CLINICAL_SECTION_PATTERNS = [
    r"^(?:CHIEF COMPLAINT|HISTORY OF PRESENT ILLNESS|PAST MEDICAL HISTORY|MEDICATIONS|ALLERGIES|PHYSICAL EXAMINATION|LABORATORY FINDINGS|LABORATORY RESULTS|DIAGNOSTIC STUDIES|IMPRESSION|ASSESSMENT AND PLAN|DISCHARGE SUMMARY|PLAN OF CARE)[:\s]",
    r"^(?:PATIENT INFORMATION|DEMOGRAPHICS|CLINICAL NOTES|VITAL SIGNS|TEST RESULTS|ORDER SUMMARY)[:\s]",
    r"^#{1,3}\s+(.+)$",  # Markdown headers
]


def normalize_clinical_text(text: str) -> str:
    """Sanitizes text by removing control characters, excessive blank lines and spaces."""
    if not text:
        return ""

    # Strip null bytes and non-printable control chars except tabs/newlines
    cleaned = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text)

    # Normalize carriage returns to unix newlines
    cleaned = cleaned.replace("\r\n", "\n").replace("\r", "\n")

    # Condense 3+ consecutive newlines to 2
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)

    # Condense multiple horizontal spaces to single space
    cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)

    return cleaned.strip()


def extract_sections(text: str) -> List[Tuple[str, str]]:
    """
    Splits text into (heading, section_content) pairs based on clinical section markers.
    If no headings are found, returns [("GENERAL", text)].
    """
    lines = text.split("\n")
    sections: List[Tuple[str, str]] = []
    current_heading = "GENERAL"
    current_lines: List[str] = []

    combined_regex = re.compile("|".join(CLINICAL_SECTION_PATTERNS), re.IGNORECASE)

    for line in lines:
        stripped = line.strip()
        match = combined_regex.match(stripped)
        if match:
            if current_lines:
                sections.append((current_heading, "\n".join(current_lines).strip()))
                current_lines = []
            current_heading = stripped.rstrip(":")
        else:
            current_lines.append(line)

    if current_lines:
        sections.append((current_heading, "\n".join(current_lines).strip()))

    return [(h, c) for h, c in sections if c]
