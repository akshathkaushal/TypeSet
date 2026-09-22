import type { TypesetAPI } from "../shared/types";
declare global {
  interface Window {
    typeset: TypesetAPI;
  }
}
