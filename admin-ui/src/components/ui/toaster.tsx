"use client";

import { Toaster, toast } from "sonner";

export function ToasterHost() {
  return <Toaster offset="10px" richColors closeButton={true} />;
}

export function useToast() {
  return toast;
}
