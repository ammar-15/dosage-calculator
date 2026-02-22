declare module "@react-native-community/datetimepicker" {
  import * as React from "react";

  export type DateTimePickerEvent = {
    type: "set" | "dismissed";
    nativeEvent: { timestamp: number; utcOffset?: number };
  };

  export interface DateTimePickerProps {
    value: Date;
    mode?: "date" | "time" | "datetime";
    display?: "default" | "spinner" | "calendar" | "clock" | "inline";
    onChange?: (event: DateTimePickerEvent, date?: Date) => void;
    minimumDate?: Date;
    maximumDate?: Date;
    is24Hour?: boolean;
    locale?: string;
    timeZoneName?: string;
  }

  const DateTimePicker: React.ComponentType<DateTimePickerProps>;
  export default DateTimePicker;
}
