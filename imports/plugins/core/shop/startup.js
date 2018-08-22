import kafka from "kafka-node";

const { Producer } = kafka;
const client = new kafka.KafkaClient({ kafkaHost: "127.0.0.1" });
const topics = ["shopsCreate", "shopsUpdate", "shopsDelete"];
const producer = new Producer(client);

producer.createTopics(topics, false, (err, data) => {
  console.log(data);
});
