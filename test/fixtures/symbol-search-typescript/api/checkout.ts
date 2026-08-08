import type { Invoice } from "../billing/invoice";
import { calculateInvoiceTotal } from "../billing/invoice";
import { InvoiceSerializer } from "./serializers";

export function serialize(invoice: Invoice): string {
    return JSON.stringify({ id: invoice.id, totalCents: calculateInvoiceTotal(invoice) });
}

export class CheckoutService {
    constructor(private readonly serializer = new InvoiceSerializer()) {}

    quote(invoice: Invoice): number {
        return calculateInvoiceTotal(invoice);
    }

    payload(invoice: Invoice) {
        return this.serializer.serialize(invoice);
    }

    serialize(invoice: Invoice): string {
        return serialize(invoice);
    }
}
