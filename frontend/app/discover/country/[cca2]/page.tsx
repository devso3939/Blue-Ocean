import ClientPage from "./client-page";

export function generateStaticParams() {
  return [{ cca2: "GE" }, { cca2: "AZ" }, { cca2: "BY" }, { cca2: "TR" }, { cca2: "AM" }];
}

export default function CountryPage({ params }: { params: { cca2: string } }) {
  return <ClientPage cca2={params.cca2} />;
}
