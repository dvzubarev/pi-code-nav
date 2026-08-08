import type { Invoice } from "../billing/invoice";
import { calculateInvoiceTotal } from "../billing/invoice";

export interface InvoicePayload {
    id: string;
    totalCents: number;
}

/** Convert a domain invoice to the public API payload. */
export function serialize(invoice: Invoice): InvoicePayload {
    return {
        id: invoice.id,
        totalCents: calculateInvoiceTotal(invoice),
    };
}

export class InvoiceSerializer {
    serialize(invoice: Invoice): InvoicePayload {
        return serialize(invoice);
    }
}
