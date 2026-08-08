"""Payment ports and an application service for checkout orchestration."""

from typing import Protocol

from .domain import Invoice, LineItem, calculate_invoice


class PaymentGateway(Protocol):
    """Port implemented by providers such as Stripe or an internal PSP."""

    async def authorize(self, invoice: Invoice) -> str:
        """Reserve funds and return the provider transaction identifier."""
        ...


class StripeGateway:
    """Production adapter around the payment provider client."""

    async def authorize(self, invoice: Invoice) -> str:
        """Authorize the invoice with the remote provider."""
        return f"stripe:{invoice.customer_id}:{invoice.subtotal}"


class CheckoutService:
    """Application service that coordinates invoice creation and payment."""

    def __init__(self, gateway: PaymentGateway):
        self.gateway = gateway

    async def execute(self, customer_id: str, items: list[LineItem]) -> str:
        """Create an invoice and authorize it through the configured gateway."""
        invoice = calculate_invoice(customer_id, items)
        return await self.gateway.authorize(invoice)
