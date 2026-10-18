import { createFileRoute } from "@tanstack/react-router";
import { CertificatesScreen } from "@/components/console/operations-screens";

export const Route = createFileRoute("/certificates")({ component: CertificatesScreen });
