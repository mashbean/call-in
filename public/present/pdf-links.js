export async function resolvePdfDestinationPage(pdf, destination) {
  const explicit =
    typeof destination === "string" ? await pdf.getDestination(destination) : destination;
  if (!Array.isArray(explicit)) return null;

  const [destinationReference] = explicit;
  let pageIndex;
  if (Number.isInteger(destinationReference)) {
    pageIndex = destinationReference;
  } else if (destinationReference && typeof destinationReference === "object") {
    pageIndex = await pdf.getPageIndex(destinationReference);
  } else {
    return null;
  }

  const pageNumber = pageIndex + 1;
  return Number.isInteger(pageNumber) && pageNumber >= 1 && pageNumber <= pdf.numPages
    ? pageNumber
    : null;
}
