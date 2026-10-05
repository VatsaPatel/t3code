import { useCallback } from "react";

import { MessageCopyButton } from "../components/chat/MessageCopyButton";
import { markdownToClipboardHtml } from "./markdownClipboardHtml";

/** Copies rendered HTML beside the markdown source so rich-text targets keep formatting. */
export function AssistantRichCopyButton({ text }: { text: string }) {
  const extraFlavors = useCallback(() => ({ "text/html": markdownToClipboardHtml(text) }), [text]);
  return (
    <MessageCopyButton text={text} extraFlavors={extraFlavors} plainOnShiftClick variant="ghost" />
  );
}
