import { cn } from "@/lib/utils/index";
import type { Experimental_GeneratedImage } from "ai";

export type ImageProps = Experimental_GeneratedImage & {
  className?: string;
  alt?: string;
};

export const Image = ({
  base64,
  mediaType,
  ...props
}: ImageProps) => (
  /* eslint-disable @next/next/no-img-element */
  <img
    {...props}
    alt={props.alt || "AI-generated image"}
    className={cn(
      "h-auto max-w-full overflow-hidden rounded-md",
      props.className
    )}
    src={`data:${mediaType};base64,${base64}`}
  />
);
