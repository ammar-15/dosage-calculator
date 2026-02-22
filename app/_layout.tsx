import { Stack } from "expo-router";
import { Provider as PaperProvider, MD3DarkTheme } from "react-native-paper";

const theme = {
  ...MD3DarkTheme,
  roundness: 18,
  colors: {
    ...MD3DarkTheme.colors,

    // True dark / “glass” palette
    background: "#000000",
    surface: "#0B0B0D",
    surfaceVariant: "#111114",

    // Text
    onBackground: "#FFFFFF",
    onSurface: "#FFFFFF",
    onSurfaceVariant: "rgba(255,255,255,0.75)",

    // Accent (teal-ish “modern”)
    primary: "#4FE3C1",
    onPrimary: "#00110C",

    outline: "rgba(255,255,255,0.12)",
  },
};

export default function RootLayout() {
  return (
    <PaperProvider theme={theme}>
      <Stack screenOptions={{ headerShown: false }} />
    </PaperProvider>
  );
}