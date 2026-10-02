/**
 * Initial travel can-do micro-goals (docs/PIANO.md §1.4). Ordered for the first eight weeks
 * (A0, then A1) and then the six-month arc (A1+, A2). The app picks the next goal by
 * `order` within the learner's level; the first-run questionnaire may reorder by priority.
 *
 * NOTE: the CEFR descriptor wording is reconstructed from memory and ALTE snippets
 * (docs/ricerca/pedagogy.md, open question 1): verify the A1/A2 wording against the CEFR
 * Companion Volume and the ALTE Can Do statements before publishing the Italian glosses.
 */

export type GoalLevel = "A0" | "A1" | "A1+" | "A2";

export type GoalDomain =
  | "AIRPORT"
  | "HOTEL"
  | "RESTAURANT"
  | "DIRECTIONS"
  | "SHOPPING"
  | "TROUBLE"
  | "SMALL_TALK";

export interface MicroGoal {
  readonly id: string;
  readonly level: GoalLevel;
  readonly domain: GoalDomain;
  readonly textEn: string;
  readonly textIt: string;
  readonly order: number;
}

export const INITIAL_GOALS: readonly MicroGoal[] = [
  // A0, weeks 1-4: greetings, numbers, basic requests, fixed formulas.
  {
    id: "g_a0_greet_name",
    level: "A0",
    domain: "SMALL_TALK",
    textEn: "Say hello, your name and where you are from",
    textIt: "Salutare, dire il tuo nome e da dove vieni",
    order: 1,
  },
  {
    id: "g_a0_polite_words",
    level: "A0",
    domain: "SMALL_TALK",
    textEn: "Say please, thank you, sorry and excuse me at the right moment",
    textIt: "Dire per favore, grazie, scusa e permesso al momento giusto",
    order: 2,
  },
  {
    id: "g_a0_dont_understand",
    level: "A0",
    domain: "TROUBLE",
    textEn: "Say you don't understand and ask to repeat",
    textIt: "Dire che non capisci e chiedere di ripetere",
    order: 3,
  },
  {
    id: "g_a0_numbers_prices",
    level: "A0",
    domain: "SHOPPING",
    textEn: "Understand and say numbers and prices up to one hundred",
    textIt: "Capire e dire numeri e prezzi fino a cento",
    order: 4,
  },
  {
    id: "g_a0_order_coffee",
    level: "A0",
    domain: "RESTAURANT",
    textEn: "Order a coffee and a croissant",
    textIt: "Ordinare un caffè e un cornetto",
    order: 5,
  },
  {
    id: "g_a0_ask_where",
    level: "A0",
    domain: "DIRECTIONS",
    textEn: "Ask where something is: the toilet, the exit, the station",
    textIt: "Chiedere dov'è qualcosa: il bagno, l'uscita, la stazione",
    order: 6,
  },
  {
    id: "g_a0_passport_control",
    level: "A0",
    domain: "AIRPORT",
    textEn: "Answer the basic questions at passport control",
    textIt: "Rispondere alle domande di base al controllo passaporti",
    order: 7,
  },
  {
    id: "g_a0_gate",
    level: "A0",
    domain: "AIRPORT",
    textEn: "Ask where the gate is and what time boarding is",
    textIt: "Chiedere dov'è il gate e a che ora è l'imbarco",
    order: 8,
  },
  {
    id: "g_a0_hotel_checkin",
    level: "A0",
    domain: "HOTEL",
    textEn: "Check in at the hotel with your name and a reservation",
    textIt: "Fare il check-in in hotel con il tuo nome e la prenotazione",
    order: 9,
  },
  {
    id: "g_a0_ask_bill",
    level: "A0",
    domain: "RESTAURANT",
    textEn: "Ask for the bill",
    textIt: "Chiedere il conto",
    order: 10,
  },
  {
    id: "g_a0_buy_water",
    level: "A0",
    domain: "SHOPPING",
    textEn: "Buy a bottle of water and ask how much it is",
    textIt: "Comprare una bottiglia d'acqua e chiedere quanto costa",
    order: 11,
  },
  {
    id: "g_a0_speak_slowly",
    level: "A0",
    domain: "TROUBLE",
    textEn: "Ask someone to speak slowly and say you speak a little English",
    textIt: "Chiedere di parlare piano e dire che parli poco inglese",
    order: 12,
  },

  // A1, weeks 5-12: short full sentences, simple questions, everyday transactions.
  {
    id: "g_a1_table_and_menu",
    level: "A1",
    domain: "RESTAURANT",
    textEn: "Ask for a table for two and order a meal from the menu",
    textIt: "Chiedere un tavolo per due e ordinare dal menù",
    order: 13,
  },
  {
    id: "g_a1_food_allergy",
    level: "A1",
    domain: "RESTAURANT",
    textEn: "Say what you can't eat and ask what is in a dish",
    textIt: "Dire cosa non puoi mangiare e chiedere cosa c'è in un piatto",
    order: 14,
  },
  {
    id: "g_a1_hotel_wifi",
    level: "A1",
    domain: "HOTEL",
    textEn: "Ask for the Wi-Fi password and the breakfast time",
    textIt: "Chiedere la password del Wi-Fi e l'orario della colazione",
    order: 15,
  },
  {
    id: "g_a1_hotel_problem",
    level: "A1",
    domain: "HOTEL",
    textEn: "Say something in the room doesn't work and ask for help",
    textIt: "Dire che qualcosa in camera non funziona e chiedere aiuto",
    order: 16,
  },
  {
    id: "g_a1_train_ticket",
    level: "A1",
    domain: "DIRECTIONS",
    textEn: "Buy a train ticket to a city, one way or return",
    textIt: "Comprare un biglietto del treno, solo andata o andata e ritorno",
    order: 17,
  },
  {
    id: "g_a1_follow_directions",
    level: "A1",
    domain: "DIRECTIONS",
    textEn: "Ask the way and understand left, right and straight on",
    textIt: "Chiedere la strada e capire sinistra, destra e dritto",
    order: 18,
  },
  {
    id: "g_a1_taxi",
    level: "A1",
    domain: "DIRECTIONS",
    textEn: "Take a taxi: say where you are going and pay",
    textIt: "Prendere un taxi: dire dove vai e pagare",
    order: 19,
  },
  {
    id: "g_a1_shop_size",
    level: "A1",
    domain: "SHOPPING",
    textEn: "Ask for a different size or colour in a shop",
    textIt: "Chiedere una taglia o un colore diverso in negozio",
    order: 20,
  },
  {
    id: "g_a1_pay_receipt",
    level: "A1",
    domain: "SHOPPING",
    textEn: "Pay by card or cash and ask for a receipt",
    textIt: "Pagare con carta o in contanti e chiedere lo scontrino",
    order: 21,
  },
  {
    id: "g_a1_lost_bag",
    level: "A1",
    domain: "TROUBLE",
    textEn: "Say you lost your bag and describe it",
    textIt: "Dire che hai perso la borsa e descriverla",
    order: 22,
  },
  {
    id: "g_a1_pharmacy",
    level: "A1",
    domain: "TROUBLE",
    textEn: "Ask at the pharmacy for something for a headache or a cold",
    textIt: "Chiedere in farmacia qualcosa per il mal di testa o il raffreddore",
    order: 23,
  },
  {
    id: "g_a1_about_trip",
    level: "A1",
    domain: "SMALL_TALK",
    textEn: "Say how long you are staying and what you want to see",
    textIt: "Dire quanto ti fermi e cosa vuoi vedere",
    order: 24,
  },

  // A1+, months 4-5: connected sentences, information and simple problems.
  {
    id: "g_a1p_flight_change",
    level: "A1+",
    domain: "AIRPORT",
    textEn: "Understand a delay or gate change and ask what to do",
    textIt: "Capire un ritardo o un cambio di gate e chiedere cosa fare",
    order: 25,
  },
  {
    id: "g_a1p_missing_suitcase",
    level: "A1+",
    domain: "AIRPORT",
    textEn: "Report a missing suitcase at the baggage desk",
    textIt: "Segnalare una valigia mancante allo sportello bagagli",
    order: 26,
  },
  {
    id: "g_a1p_hotel_change",
    level: "A1+",
    domain: "HOTEL",
    textEn: "Ask to change room or to stay one more night",
    textIt: "Chiedere di cambiare camera o di restare una notte in più",
    order: 27,
  },
  {
    id: "g_a1p_wrong_order",
    level: "A1+",
    domain: "RESTAURANT",
    textEn: "Say politely that the order is wrong and ask to change it",
    textIt: "Dire con garbo che l'ordine è sbagliato e chiedere di cambiarlo",
    order: 28,
  },
  {
    id: "g_a1p_public_transport",
    level: "A1+",
    domain: "DIRECTIONS",
    textEn: "Ask which bus or metro line to take and where to get off",
    textIt: "Chiedere quale autobus o linea della metro prendere e dove scendere",
    order: 29,
  },
  {
    id: "g_a1p_return_item",
    level: "A1+",
    domain: "SHOPPING",
    textEn: "Return or exchange something you bought",
    textIt: "Restituire o cambiare qualcosa che hai comprato",
    order: 30,
  },
  {
    id: "g_a1p_health_problem",
    level: "A1+",
    domain: "TROUBLE",
    textEn: "Explain a simple health problem to a doctor or a pharmacist",
    textIt: "Spiegare un problema di salute semplice a un medico o a un farmacista",
    order: 31,
  },
  {
    id: "g_a1p_job_family",
    level: "A1+",
    domain: "SMALL_TALK",
    textEn: "Talk about your job and your family in a few sentences",
    textIt: "Parlare del tuo lavoro e della tua famiglia in poche frasi",
    order: 32,
  },

  // A2, month 6: several turns, past narration, opinions, polite complaints.
  {
    id: "g_a2_missed_connection",
    level: "A2",
    domain: "AIRPORT",
    textEn: "Explain that you missed a connection and ask for the next flight",
    textIt: "Spiegare che hai perso la coincidenza e chiedere il prossimo volo",
    order: 33,
  },
  {
    id: "g_a2_hotel_complaint",
    level: "A2",
    domain: "HOTEL",
    textEn: "Complain about noise or cleanliness and ask for a solution",
    textIt: "Fare un reclamo per il rumore o la pulizia e chiedere una soluzione",
    order: 34,
  },
  {
    id: "g_a2_recommendation",
    level: "A2",
    domain: "RESTAURANT",
    textEn: "Ask for a recommendation and say what you liked about the meal",
    textIt: "Chiedere un consiglio e dire cosa ti è piaciuto del pasto",
    order: 35,
  },
  {
    id: "g_a2_police_report",
    level: "A2",
    domain: "TROUBLE",
    textEn: "Report a theft to the police and say what happened",
    textIt: "Denunciare un furto alla polizia e raccontare cosa è successo",
    order: 36,
  },
  {
    id: "g_a2_yesterday_tomorrow",
    level: "A2",
    domain: "SMALL_TALK",
    textEn: "Tell someone what you did yesterday and what you plan for tomorrow",
    textIt: "Raccontare cosa hai fatto ieri e cosa farai domani",
    order: 37,
  },
  {
    id: "g_a2_opinions",
    level: "A2",
    domain: "SMALL_TALK",
    textEn: "Give your opinion about a place and ask for someone else's",
    textIt: "Dare la tua opinione su un posto e chiedere quella di un altro",
    order: 38,
  },
];
