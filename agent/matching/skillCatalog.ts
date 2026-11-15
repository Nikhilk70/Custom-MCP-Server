/**
 * Technology vocabulary used to detect skills in JD text. Detection is purely lexical against the JD,
 * so a skill is only ever "required" if the JD actually mentions it.
 * `aliases` are extra names tried when looking the skill up in the user's profile.
 */
export interface CatalogSkill {
  name: string;
  pattern: RegExp;
  aliases?: string[];
}

const s = (name: string, pattern: RegExp, aliases?: string[]): CatalogSkill => (aliases ? { name, pattern, aliases } : { name, pattern });

export const SKILL_CATALOG: CatalogSkill[] = [
  s("Java", /\bjava\b(?!\s*script)/i, ["Core Java"]),
  s("JavaScript", /\bjavascript\b|\bES6\b|\bECMAScript\b/i),
  s("TypeScript", /\btypescript\b/i),
  s("Python", /\bpython\b/i),
  s("Golang", /\bgolang\b/i),
  s("Rust", /\brust\b(?!\s*belt)/i),
  s("C++", /(^|[^a-z])c\+\+/i),
  // ".NET" must stand alone — "doubleclick.net" in a scraped cookie banner is not a skill requirement.
  s("C#", /(^|[^a-z0-9])c#(?![a-z0-9])|(^|[\s(,/])\.net\b|\basp\.net\b|\bdotnet\b/i),
  s("PHP", /\bphp\b/i),
  s("Ruby", /\bruby\b/i),
  s("Kotlin", /\bkotlin\b/i),
  s("Swift", /\bswift\b(?!\s*code)/i),
  s("Scala", /\bscala\b/i),
  s("SQL", /\bsql\b/i),
  s("HTML", /\bhtml5?\b/i, ["HTML5"]),
  s("CSS", /\bcss3?\b/i, ["CSS3"]),
  s("Google Apps Script", /\b(google\s+)?apps?\s+script\b/i),
  s("Bash", /\bbash\b|\bshell script(ing)?\b/i),
  s("React", /\breact(\.js|js)?\b(?!\s*native)/i),
  s("React Native", /\breact\s+native\b/i),
  s("Next.js", /\bnext\.?js\b/i),
  s("Angular", /\bangular(js)?\b/i),
  s("Vue.js", /\bvue(\.js|js)?\b/i),
  s("Redux", /\bredux\b/i),
  s("Tailwind CSS", /\btailwind\b/i),
  s("Bootstrap", /\bbootstrap\b/i),
  s("jQuery", /\bjquery\b/i),
  s("Node.js", /\bnode\.?js\b/i),
  s("Express.js", /\bexpress\.?js\b|\bexpress framework\b/i),
  s("NestJS", /\bnest\.?js\b/i),
  s("Spring Boot", /\bspring\s*boot\b/i, ["SpringBoot"]),
  s("Spring", /\bspring\b(?!\s*(boot|security|cloud|mvc|batch|data))(?!\s+(semester|internship|intern|season|break|20\d\d))/i, ["Spring Core", "Spring Framework"]),
  s("Spring MVC", /\bspring\s*mvc\b/i),
  s("Spring Security", /\bspring\s*security\b/i),
  s("Spring Cloud", /\bspring\s*cloud\b/i),
  s("Hibernate", /\bhibernate\b/i),
  s("JPA", /\bjpa\b/i),
  s("JDBC", /\bjdbc\b/i),
  s("Servlets", /\bservlets?\b/i),
  s("JSP", /\bjsp\b/i),
  s("Django", /\bdjango\b/i),
  s("Flask", /\bflask\b/i),
  s("FastAPI", /\bfast\s?api\b/i),
  // Bare "REST" is case-sensitive so the English word "rest" does not count.
  s("REST APIs", /\bREST(ful)?\b|\b[Rr]estful\b|\b[Rr]est\s*(APIs?|apis?|[Ss]ervices|web services|endpoints)\b/, ["REST"]),
  s("GraphQL", /\bgraphql\b/i),
  s("gRPC", /\bgrpc\b/i),
  s("WebSockets", /\bweb\s?sockets?\b/i),
  s("Microservices", /\bmicro-?services?\b/i),
  s("MySQL", /\bmysql\b/i),
  s("PostgreSQL", /\bpostgres(ql)?\b/i),
  s("MongoDB", /\bmongo(db)?\b/i),
  s("Oracle Database", /\boracle\s+(database|db|sql)\b|\bpl\/sql\b/i),
  s("SQL Server", /\b(ms\s*)?sql\s*server\b/i),
  s("Redis", /\bredis\b/i),
  s("Elasticsearch", /\belastic\s?search\b/i),
  s("DynamoDB", /\bdynamo\s?db\b/i),
  s("Cassandra", /\bcassandra\b/i),
  s("Kafka", /\bkafka\b/i),
  s("RabbitMQ", /\brabbit\s?mq\b/i),
  s("AWS", /\baws\b|\bamazon web services\b/i),
  s("Azure", /\bazure\b/i),
  s("GCP", /\bgcp\b|\bgoogle cloud\b/i),
  s("Docker", /\bdocker\b/i),
  s("Kubernetes", /\bkubernetes\b|\bk8s\b/i),
  s("Terraform", /\bterraform\b/i),
  s("Jenkins", /\bjenkins\b/i),
  s("CI/CD", /\bci\s*\/\s*cd\b|\bcontinuous (integration|delivery|deployment)\b/i),
  s("Linux", /\blinux\b|\bunix\b/i),
  s("Nginx", /\bnginx\b/i),
  s("Tomcat", /\btomcat\b/i),
  s("Maven", /\bmaven\b/i),
  s("Gradle", /\bgradle\b/i),
  s("Git", /\bgit\b(?!hub|lab)/i),
  s("GitHub", /\bgithub\b/i),
  s("JUnit", /\bjunit\b/i),
  s("Mockito", /\bmockito\b/i),
  s("Selenium", /\bselenium\b/i),
  s("Jest", /\bjest\b/i),
  s("Unit Testing", /\bunit[- ]test(s|ing)?\b/i),
  s("Agile", /\bagile\b|\bscrum\b/i),
  s("Jira", /\bjira\b/i),
  s("Postman", /\bpostman\b/i),
  s("OOP", /\bobject[- ]oriented\b|\boops?\b/i),
  s("Data Structures & Algorithms", /\bdata structures?\b|\bdsa\b|\balgorithms\b/i),
  s("System Design", /\bsystem design\b/i),
  s("Design Patterns", /\bdesign patterns?\b/i, ["Singleton", "Model-View-Controller (MVC)"]),
  s("MVC", /\bmvc\b/i, ["Model-View-Controller (MVC)"]),
  s("JSON", /\bjson\b/i),
  s("XML", /\bxml\b/i),
  s("OAuth", /\boauth\s?2?(\.0)?\b/i),
  s("JWT", /\bjwt\b/i),
  s("Machine Learning", /\bmachine learning\b|\bML\b/),
  s("Deep Learning", /\bdeep learning\b/i),
  s("TensorFlow", /\btensorflow\b/i),
  s("PyTorch", /\bpytorch\b/i),
  s("Keras", /\bkeras\b/i),
  s("LLMs", /\bllms?\b|\blarge language models?\b|\bgenerative ai\b|\bgenai\b/i),
  s("RAG", /\brag\b|\bretrieval[- ]augmented\b/i),
  s("LangChain", /\blangchain\b/i),
  s("Vector Databases", /\bvector (database|db|store)s?\b|\bpinecone\b|\bchroma(db)?\b|\bweaviate\b|\bmilvus\b/i, ["ChromaDB"]),
  s("NLP", /\bnlp\b|\bnatural language processing\b/i),
  s("Computer Vision", /\bcomputer vision\b|\bopencv\b/i),
  s("Pandas", /\bpandas\b/i),
  s("NumPy", /\bnumpy\b/i),
  s("Apache Spark", /\b(apache\s+)?spark\b/i),
  s("Airflow", /\bairflow\b/i),
  s("Snowflake", /\bsnowflake\b/i),
  s("Power BI", /\bpower\s?bi\b/i),
  s("Tableau", /\btableau\b/i),
  s("Android", /\bandroid\b/i),
  s("iOS", /\bios\b/i),
  s("Flutter", /\bflutter\b/i),
  s("Firebase", /\bfirebase\b/i),
  s("Google Sheets", /\bgoogle sheets\b/i),
];

/** Returns catalog skills mentioned in text (deduped, in catalog order). */
export function detectSkills(text: string): string[] {
  const found: string[] = [];
  for (const sk of SKILL_CATALOG) if (sk.pattern.test(text)) found.push(sk.name);
  // "Spring Boot" implies "Spring" was matched only via the dedicated negative lookahead; keep both distinct.
  return found;
}

export function catalogEntry(name: string): CatalogSkill | undefined {
  return SKILL_CATALOG.find((c) => c.name === name);
}
