"""Immutable invoice domain objects for a small commerce service."""

from dataclasses import dataclass
from decimal import Decimal
from typing import Iterable


@dataclass(frozen=True)
class LineItem:
    """A billable product line received from the checkout API."""

    sku: str
    quantity: int
    unit_price: Decimal

    def total(self) -> Decimal:
        """Return the extended price for this line."""
        return self.unit_price * self.quantity


@dataclass(frozen=True)
class Invoice:
    """The finalized amount and lines for one customer purchase."""

    customer_id: str
    lines: tuple[LineItem, ...]
    subtotal: Decimal

    def serialize(self) -> dict[str, object]:
        """Return the stable wire representation used by API responses."""
        return {
            "customer_id": self.customer_id,
            "lines": [line.sku for line in self.lines],
            "subtotal": str(self.subtotal),
        }


def calculate_invoice(customer_id: str, items: Iterable[LineItem]) -> Invoice:
    """Build an invoice after validating that the cart is not empty."""
    lines = tuple(items)
    if not lines:
        raise ValueError("cannot invoice an empty cart")
    subtotal = sum((line.total() for line in lines), Decimal("0"))
    return Invoice(customer_id=customer_id, lines=lines, subtotal=subtotal)
