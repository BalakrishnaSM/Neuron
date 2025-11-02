# TODO: Implement User Authentication and History Tracking

- [x] Add required dependencies (pymongo, flask-jwt-extended, bcrypt) to requirements.txt
- [x] Create models.py with User and History classes for MongoDB operations
- [x] Update app.py to include JWT authentication and MongoDB setup
- [x] Add authentication endpoints: /register, /login
- [x] Add /history endpoint for retrieving user calculation history
- [x] Protect /calculate endpoint with JWT authentication
- [x] Integrate history saving in the /calculate endpoint for text calculations
- [x] Test the authentication and history features
