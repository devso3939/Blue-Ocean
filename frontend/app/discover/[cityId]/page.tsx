import ClientPage from "./client-page";

export function generateStaticParams() {
  return [{ cityId: "tbilisi-ge" }, { cityId: "batumi-ge" }, { cityId: "baku-az" }, { cityId: "minsk-by" }, { cityId: "istanbul-tr" }];
}

export default function DiscoverPage({ params }: { params: { cityId: string } }) {
  return <ClientPage cityId={params.cityId} />;
}
