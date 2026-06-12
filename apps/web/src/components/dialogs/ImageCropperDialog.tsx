"use client";

import { useState, useRef, useCallback } from "react";
import ReactCrop, {
  centerCrop,
  makeAspectCrop,
  type Crop,
  type PixelCrop,
} from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Loader2, Circle, Square } from "lucide-react";

interface ImageCropperDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  imageSrc: string;
  onCropComplete: (croppedBlob: Blob) => void;
}

type CropShape = "circle" | "square";

function centerAspectCrop(
  mediaWidth: number,
  mediaHeight: number,
  aspect: number
): Crop {
  return centerCrop(
    makeAspectCrop(
      {
        unit: "%",
        width: 90,
      },
      aspect,
      mediaWidth,
      mediaHeight
    ),
    mediaWidth,
    mediaHeight
  );
}

async function getCroppedImage(
  image: HTMLImageElement,
  crop: PixelCrop,
  shape: CropShape
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  if (!ctx) {
    throw new Error("No 2d context");
  }

  const MAX_AVATAR_SIZE = 512;

  const scaleX = image.naturalWidth / image.width;
  const scaleY = image.naturalHeight / image.height;

  const naturalWidth = crop.width * scaleX;
  const naturalHeight = crop.height * scaleY;

  // Cap output to MAX_AVATAR_SIZE — devicePixelRatio is a display trick and doesn't belong in a file export;
  // without this cap, large source images (e.g. phone photos) produce 6000×6000px PNGs that exceed the 5MB limit.
  const downScale = Math.min(1, MAX_AVATAR_SIZE / Math.max(naturalWidth, naturalHeight));

  canvas.width = Math.floor(naturalWidth * downScale);
  canvas.height = Math.floor(naturalHeight * downScale);

  ctx.scale(downScale, downScale);
  ctx.imageSmoothingQuality = "high";

  const cropX = crop.x * scaleX;
  const cropY = crop.y * scaleY;

  // Apply circular mask if shape is circle
  if (shape === "circle") {
    ctx.beginPath();
    ctx.arc(
      naturalWidth / 2,
      naturalHeight / 2,
      Math.min(naturalWidth, naturalHeight) / 2,
      0,
      2 * Math.PI
    );
    ctx.clip();
  }

  ctx.drawImage(
    image,
    cropX,
    cropY,
    naturalWidth,
    naturalHeight,
    0,
    0,
    naturalWidth,
    naturalHeight
  );

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("Failed to create blob"));
        }
      },
      "image/png",
      1
    );
  });
}

export function ImageCropperDialog({
  open,
  onOpenChange,
  imageSrc,
  onCropComplete,
}: ImageCropperDialogProps) {
  const [crop, setCrop] = useState<Crop>();
  const [completedCrop, setCompletedCrop] = useState<PixelCrop>();
  const [shape, setShape] = useState<CropShape>("circle");
  const [isProcessing, setIsProcessing] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  const onImageLoad = useCallback(
    (e: React.SyntheticEvent<HTMLImageElement>) => {
      const { width, height } = e.currentTarget;
      setCrop(centerAspectCrop(width, height, 1));
    },
    []
  );

  const handleCropComplete = async () => {
    if (!imgRef.current || !completedCrop) return;

    setIsProcessing(true);
    try {
      const croppedBlob = await getCroppedImage(
        imgRef.current,
        completedCrop,
        shape
      );
      onCropComplete(croppedBlob);
      onOpenChange(false);
    } catch (error) {
      console.error("Error cropping image:", error);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Crop Avatar</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex justify-center">
            <RadioGroup
              value={shape}
              onValueChange={(value) => setShape(value as CropShape)}
              className="flex gap-4"
            >
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="circle" id="circle" />
                <Label htmlFor="circle" className="flex items-center gap-1 cursor-pointer">
                  <Circle className="h-4 w-4" />
                  Circle
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="square" id="square" />
                <Label htmlFor="square" className="flex items-center gap-1 cursor-pointer">
                  <Square className="h-4 w-4" />
                  Square
                </Label>
              </div>
            </RadioGroup>
          </div>

          <div className="flex justify-center max-h-[400px] overflow-auto">
            <ReactCrop
              crop={crop}
              onChange={(_, percentCrop) => setCrop(percentCrop)}
              onComplete={(c) => setCompletedCrop(c)}
              aspect={1}
              circularCrop={shape === "circle"}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                ref={imgRef}
                alt="Crop preview"
                src={imageSrc}
                onLoad={onImageLoad}
                className="max-w-full"
              />
            </ReactCrop>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isProcessing}
          >
            Cancel
          </Button>
          <Button
            onClick={handleCropComplete}
            disabled={!completedCrop || isProcessing}
          >
            {isProcessing ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Processing...
              </>
            ) : (
              "Apply"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
