"""
MediMate AI — Multi-Engine PDF Parser
Adapted from HealthMate AI (MIT License, Copyright 2025 HealthMate AI).
Enhanced with page-level provenance, SHA-256 integrity, and strict emptiness detection.
"""

import hashlib
import io
from typing import List

from app.core.errors import DocumentParsingError, EmptyDocumentError
from app.core.logging import logger
from app.parsing.base import BaseDocumentParser, ParsedDocument, ParsedPage
from app.parsing.normalizer import normalize_clinical_text


class PDFDocumentParser(BaseDocumentParser):
    """Robust PDF document parser supporting pypdf and optional PyMuPDF."""

    def parse_bytes(self, content: bytes, file_name: str, document_id: str) -> ParsedDocument:
        if not content or len(content) == 0:
            raise EmptyDocumentError(f"Document '{file_name}' contains zero bytes")

        content_hash = hashlib.sha256(content).hexdigest()
        pages: List[ParsedPage] = []
        extraction_method = "unknown"

        # Check if binary PDF
        is_binary_pdf = content.startswith(b"%PDF")

        if is_binary_pdf:
            # Strategy 1: PyMuPDF (fitz) if installed
            try:
                import fitz
                doc = fitz.open(stream=content, filetype="pdf")
                for page_num, page in enumerate(doc):
                    text = page.get_text("text") or ""
                    clean_text = normalize_clinical_text(text)
                    if clean_text:
                        pages.append(
                            ParsedPage(
                                page_number=page_num + 1,
                                text=clean_text,
                                char_count=len(clean_text),
                            )
                        )
                doc.close()
                extraction_method = "pymupdf"
            except ImportError:
                # Strategy 2: pypdf (standard reliable fallback)
                try:
                    from pypdf import PdfReader
                    reader = PdfReader(io.BytesIO(content))
                    for page_num, page in enumerate(reader.pages):
                        text = page.extract_text() or ""
                        clean_text = normalize_clinical_text(text)
                        if clean_text:
                            pages.append(
                                ParsedPage(
                                    page_number=page_num + 1,
                                    text=clean_text,
                                    char_count=len(clean_text),
                                )
                            )
                    extraction_method = "pypdf"
                except Exception as e:
                    logger.warning(f"PDF extraction with pypdf encountered error: {str(e)}")
            except Exception as e:
                logger.warning(f"PDF extraction with fitz encountered error: {str(e)}")

        # Fallback or plain text / markdown multi-page splitting
        if not pages:
            try:
                raw_text = content.decode("utf-8", errors="ignore")
                clean_text = normalize_clinical_text(raw_text)
                if clean_text:
                    import re
                    # Look for explicit "--- Page X ---" page markers
                    page_splits = re.split(r"(?:^|\n)---\s*Page\s*(\d+)\s*---\n?", clean_text)
                    if len(page_splits) > 1:
                        # [preamble, page_1_num, page_1_text, page_2_num, page_2_text, ...]
                        idx = 1
                        while idx < len(page_splits) - 1:
                            p_num = int(page_splits[idx])
                            p_text = normalize_clinical_text(page_splits[idx + 1])
                            if p_text:
                                pages.append(
                                    ParsedPage(
                                        page_number=p_num,
                                        text=p_text,
                                        char_count=len(p_text),
                                    )
                                )
                            idx += 2
                    else:
                        pages.append(
                            ParsedPage(
                                page_number=1,
                                text=clean_text,
                                char_count=len(clean_text),
                            )
                        )
                    extraction_method = "text_markdown_parser"
            except Exception as err:
                logger.error(f"Text decoding fallback failed: {str(err)}")

        if not pages:
            raise EmptyDocumentError(
                f"Document '{file_name}' contains no readable or extractable text"
            )

        total_chars = sum(p.char_count for p in pages)
        return ParsedDocument(
            document_id=document_id,
            file_name=file_name,
            content_hash=content_hash,
            pages=pages,
            total_pages=len(pages),
            total_characters=total_chars,
            extraction_method=extraction_method,
        )
