import kafka from "kafka-node";

const { Producer } = kafka;

export default function setShopName(shop) {
  const { _id } = shop;

  const client = new kafka.KafkaClient({ kafkaHost: "127.0.0.1" });
  const producer = new Producer(client);

  const payload = {
    topic: "shopsUpdate",
    messages: {
      updateType: "setShopName",
      updateData: {
        _id,
        name
      }
    }
  };

  const payloads = [payload];

  producer.on("ready", () => {
    producer.send(payloads, (err, data) => {
      console.log(data);
    });
  });

  producer.on("error", (err) => {
    console.log("error", err);
  });

}
