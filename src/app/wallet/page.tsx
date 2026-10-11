import { redirect } from "next/navigation";
import { WalletPanel } from "@/components/wallet-panel";
import { Card } from "@/components/ui/card";
import { getPageSession } from "@/server/page-session";
import { providersFor } from "@/server/providers";
import { getWallet } from "@/server/services/wallet-service";

export default async function WalletPage() {
  const current = await getPageSession();
  if (!current?.session.selectedShopperId) redirect("/");
  const wallet = await getWallet(
    providersFor(current.session.mode),
    current.session,
    current.session.selectedShopperId,
  ).catch((error: unknown) => (error instanceof Error ? error.message : "Wallet unavailable."));
  if (typeof wallet === "string") {
    return (
      <Card role="alert">
        <p className="font-semibold text-danger">{wallet}</p>
      </Card>
    );
  }
  return <WalletPanel initial={wallet} key={wallet.shopperId} />;
}
