import * as stylex from "@stylexjs/stylex";
import { useCallback, useState } from "react";
import { Camera, Check, RefreshCw } from "lucide-react";
import { focus, layout, motion, pressable } from "@orbmeet/ui/styles/atoms";
import { blur } from "@orbmeet/ui/styles/surfaces";
import { cameraMenu } from "@/modules/meetings/client/meeting-styles";
import { PopoverContent, PopoverRoot, PopoverTrigger } from "@orbmeet/ui/react";

interface CameraSwitchButtonProps {
  videoDevices: MediaDeviceInfo[];
  currentDeviceId: string | undefined;
  onSelectDevice: (deviceId: string | undefined) => void;
  onRefreshDevices?: () => void;
  popoverSide?: "top" | "bottom" | "left" | "right";
  popoverAlign?: "start" | "center" | "end";
}

/**
 * The camera switcher. One component, one definition of its popover — it used
 * to exist twice (gallery tile and mobile strip) and the copies had drifted.
 * See `cameraMenu` in `meeting-styles.ts`.
 */
export function CameraSwitchButton({
  videoDevices,
  currentDeviceId,
  onSelectDevice,
  onRefreshDevices,
  popoverSide = "top",
  popoverAlign = "end",
}: CameraSwitchButtonProps) {
  const [open, setOpen] = useState(false);
  const concreteVideoDevices = videoDevices.filter((device) => device.deviceId !== "default");

  const handleSelect = useCallback(
    (deviceId: string | undefined) => {
      onSelectDevice(deviceId);
      setOpen(false);
    },
    [onSelectDevice],
  );

  const renderOption = (
    key: string,
    label: string,
    deviceId: string | undefined,
    onSelect: () => void,
  ) => {
    const selected = currentDeviceId === deviceId;
    return (
      <button
        key={key}
        onClick={onSelect}
        {...stylex.props(
          pressable.base,
          motion.tint,
          cameraMenu.option,
          selected && cameraMenu.optionSelected,
        )}
      >
        <div
          {...stylex.props(
            cameraMenu.optionGlyph,
            selected && cameraMenu.optionGlyphSelected,
          )}
        >
          {selected ? <Check size={12} /> : <Camera size={12} />}
        </div>
        <span {...stylex.props(cameraMenu.optionLabel, layout.truncate)}>{label}</span>
      </button>
    );
  };

  return (
    <PopoverRoot open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            title="Switch camera"
            aria-label="Switch camera"
            {...stylex.props(pressable.base, motion.tint, focus.ringOnDark, cameraMenu.trigger)}
          >
            <Camera size={16} />
          </button>
        }
      />
      <PopoverContent
        title="Switch camera"
        side={popoverSide}
        align={popoverAlign}
        sideOffset={8}
        sx={[cameraMenu.panel, blur.xl]}
      >
        <div {...stylex.props(cameraMenu.headingRow)}>
          <p {...stylex.props(cameraMenu.heading)}>Switch camera</p>
          {onRefreshDevices && (
            <button
              onClick={onRefreshDevices}
              title="Refresh devices"
              {...stylex.props(pressable.base, motion.tint, focus.ringOnDark, cameraMenu.refresh)}
            >
              <RefreshCw size={12} />
            </button>
          )}
        </div>
        <div {...stylex.props(cameraMenu.list)}>
          {renderOption("default", "System default", undefined, () => handleSelect(undefined))}
          {concreteVideoDevices.map((device) =>
            renderOption(
              device.deviceId,
              device.label || `Camera ${device.deviceId.slice(0, 8)}`,
              device.deviceId,
              () => handleSelect(device.deviceId),
            ),
          )}
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}
