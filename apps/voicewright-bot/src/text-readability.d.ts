// text-readability@1.1.1 ships no type declarations; declare the slice we use.
declare module 'text-readability' {
  interface Readability {
    fleschKincaidGrade(text: string): number;
    fleschReadingEase(text: string): number;
    textStandard(text: string, floatOutput?: boolean): string | number;
  }
  const readability: Readability;
  export default readability;
}
