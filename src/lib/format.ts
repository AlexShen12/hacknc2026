import type { GroupStatus, OperationStatus, Retailer } from "@/domain/types";

export { formatCents } from "@/domain/money";

const pickupDay = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  month: "short",
  day: "numeric",
});
const pickupTime = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "2-digit",
});

const easternDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Calendar date (YYYY-MM-DD) in America/New_York, used for bill due dates. */
export function easternDate(date: Date): string {
  return easternDay.format(date);
}

/** Pickup windows are stored in UTC and always displayed in America/New_York. */
export function formatPickupWindow(startsAt: string, endsAt: string): string {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  return `${pickupDay.format(start)}, ${pickupTime.format(start)}–${pickupTime.format(end)} ET`;
}

export const RETAILER_LABELS: Record<Retailer, string> = {
  walmart: "Walmart",
  costco: "Costco",
  sams_club: "Sam's Club",
};

export const MEMBERSHIP_LABELS: Record<"costco" | "sams_club", string> = {
  costco: "Costco",
  sams_club: "Sam's Club",
};

export const GROUP_STATUS_LABELS: Record<GroupStatus, string> = {
  open: "Open — looking for members",
  awaiting_confirmation: "Waiting for everyone to confirm",
  funding: "Collecting contributions",
  returning_contribution: "Returning a contribution",
  replacement_needed: "Looking for a replacement",
  ready_to_purchase: "Ready to purchase",
  purchasing: "Recording purchase",
  purchased: "Purchased — ready for pickup",
  fulfilled: "Complete",
  cancelling: "Cancelling and returning funds",
  cancelled: "Cancelled",
};

export const OPERATION_STATUS_LABELS: Record<OperationStatus, string> = {
  prepared: "Prepared",
  dispatching: "Sending",
  pending: "Pending",
  confirmed: "Confirmed",
  failed: "Failed",
  unknown: "Outcome unknown",
};
