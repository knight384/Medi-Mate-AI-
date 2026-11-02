"""
MediMate AI — Multi-Tenant Isolation Enforcer
Guarantees that database queries, storage keys, and vector search operations
are strictly scoped to the authenticated tenant and user.
"""

from typing import Optional
from app.core.errors import TenantIsolationError
from app.security.assertion import InternalServiceClaims


class TenantContext:
    """Explicit execution context containing verified identity claims."""

    def __init__(self, claims: InternalServiceClaims):
        self.user_id = claims.sub
        self.tenant_id = claims.tenantId
        self.operation = claims.op
        self.purpose = claims.purpose

    def assert_ownership(self, target_user_id: str, target_tenant_id: Optional[str] = None):
        """Rejects operations attempting to access or manipulate data owned by another user or tenant."""
        if target_user_id != self.user_id:
            raise TenantIsolationError(
                f"Cross-user violation: authenticated user '{self.user_id}' cannot access records for '{target_user_id}'"
            )
        if target_tenant_id and target_tenant_id != self.tenant_id:
            raise TenantIsolationError(
                f"Cross-tenant violation: authenticated tenant '{self.tenant_id}' cannot access records for '{target_tenant_id}'"
            )
