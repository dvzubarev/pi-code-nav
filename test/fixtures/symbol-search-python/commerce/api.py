"""HTTP-facing functions kept intentionally thin for the example service."""

from .domain import Invoice
from .payments import CheckoutService


def serialize(invoice: Invoice) -> dict[str, object]:
    """Serialize an invoice for the HTTP response envelope."""
    return invoice.serialize()


async def execute_checkout(
    service: CheckoutService, customer_id: str, items: list
) -> dict[str, object]:
    """Run checkout and return a response containing the payment id."""
    payment_id = await service.execute(customer_id, items)
    return {"payment_id": payment_id}
