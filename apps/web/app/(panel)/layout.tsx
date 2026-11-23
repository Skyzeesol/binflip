import { Shell } from "@/components/Shell";
import { CurrencyProvider } from "@/lib/currency";

export default function PanelLayout({ children }: { children: React.ReactNode }) {
  return (
    <CurrencyProvider>
      <Shell>{children}</Shell>
    </CurrencyProvider>
  );
}
