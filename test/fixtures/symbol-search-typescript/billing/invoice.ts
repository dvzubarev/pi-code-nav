export type InvoiceStatus = "draft" | "issued" | "paid";

export interface Invoice {
    id: string;
    customerId: string;
    subtotalCents: number;
    taxCents: number;
    status: InvoiceStatus;
}

/** Calculate the amount that should be charged for an invoice. */
export function calculateInvoiceTotal(invoice: Invoice): number {
    return invoice.subtotalCents + invoice.taxCents;
}

/** Serialize an invoice for the billing event stream. */
export function serialize(invoice: Invoice): string {
    return JSON.stringify({
        id: invoice.id,
        totalCents: calculateInvoiceTotal(invoice),
        status: invoice.status,
    });
}

export class InvoiceLedger {
    private readonly invoices = new Map<string, Invoice>();

    constructor(private readonly tenantId: string) {}

    record(invoice: Invoice): void {
        this.invoices.set(invoice.id, invoice);
    }

    find(invoiceId: string): Invoice | undefined {
        return this.invoices.get(invoiceId);
    }

    serialize(invoice: Invoice): string {
        return serialize(invoice);
    }
}
