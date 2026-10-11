import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleX,
  Clock,
  Loader,
  PackageCheck,
  RotateCcw,
  ShoppingBag,
  UserSearch,
  Users,
} from "lucide-react";
import { Badge, type Tone } from "@/components/ui/badge";
import type { GroupStatus, OperationStatus } from "@/domain/types";
import { GROUP_STATUS_LABELS, OPERATION_STATUS_LABELS } from "@/lib/format";

const GROUP_TONES: Record<GroupStatus, { tone: Tone; Icon: typeof Clock }> = {
  open: { tone: "info", Icon: Users },
  awaiting_confirmation: { tone: "info", Icon: Clock },
  funding: { tone: "info", Icon: Loader },
  returning_contribution: { tone: "warn", Icon: RotateCcw },
  replacement_needed: { tone: "warn", Icon: UserSearch },
  ready_to_purchase: { tone: "savings", Icon: CircleCheck },
  purchasing: { tone: "info", Icon: ShoppingBag },
  purchased: { tone: "savings", Icon: ShoppingBag },
  fulfilled: { tone: "savings", Icon: PackageCheck },
  cancelling: { tone: "warn", Icon: RotateCcw },
  cancelled: { tone: "neutral", Icon: CircleX },
};

export function GroupStatusBadge({ status }: { status: GroupStatus }) {
  const { tone, Icon } = GROUP_TONES[status];
  return (
    <Badge tone={tone} icon={<Icon size={14} aria-hidden />}>
      {GROUP_STATUS_LABELS[status]}
    </Badge>
  );
}

const OPERATION_TONES: Record<OperationStatus, { tone: Tone; Icon: typeof Clock }> = {
  prepared: { tone: "neutral", Icon: CircleDashed },
  dispatching: { tone: "info", Icon: Loader },
  pending: { tone: "info", Icon: Clock },
  confirmed: { tone: "savings", Icon: CircleCheck },
  failed: { tone: "danger", Icon: CircleAlert },
  unknown: { tone: "warn", Icon: CircleHelp },
};

export function OperationStatusBadge({
  status,
  label,
}: {
  status: OperationStatus;
  label?: string;
}) {
  const { tone, Icon } = OPERATION_TONES[status];
  return (
    <Badge tone={tone} icon={<Icon size={14} aria-hidden />}>
      {label ?? OPERATION_STATUS_LABELS[status]}
    </Badge>
  );
}
