import ClientPage from "./client-page";

export default function CountryPage({ params }: { params: { cca2: string } }) {
  return <ClientPage cca2={params.cca2} />;
}
